//! Win32 Job Object 进程围栏（spec F1.1）。
//!
//! 安全模型：
//!   1. `KILL_ON_JOB_CLOSE` —— Supervisor 崩溃/退出时 OS 内核自动回收 Job 内
//!      全部进程（含孙进程），**杜绝孤儿插件进程**；
//!   2. `PROCESS_MEMORY` / `JOB_MEMORY` —— 每插件内存硬上限，插件内存泄漏
//!      不再拖垮核心；
//!   3. CPU_RATE 配额（千分比单位，10000 = 100%）—— 限制插件 CPU 独占；
//!   4. assign_to_job —— 由 Node 侧 `child_process.spawn` 创建 Host（libuv
//!      持有 stdio 管道），本模块在 spawn 后立即 `OpenProcess(pid)` +
//!      `AssignProcessToJobObject` 把进程绑入围栏。
//!
//! 关于「原子 spawn-into-job」的实现说明（与 spec 的偏差，工程决策）：
//! Node 26 的 libuv 在 Windows 上已不再使用 CRT fd 表（自建 fd 仿真层），
//! 原生模块经 `_open_osfhandle` 产出的 fd 对 Node 的 fs/stream API 全部
//! EBADF —— 即「Rust 侧 CreateProcessW + 管道 + 挂起→assign→resume」无法
//! 把 stdio 交还给 Node。故采用混合围栏：Node spawn（管道可靠）+ Rust
//! assign（Job 绑定）。竞态窗口（spawn 与 assign 之间）由协议层闭合——
//! host-bootstrap 在收到 Supervisor 的 `init` 请求前不加载任何插件代码，
//! 因此「插件代码在围栏外执行」在效果上不可能发生。
//!
//! 非 Windows：全部 Job 调用返回错误（TS 侧 job-fence 使用独立 POSIX
//! process group 回收）；本模块设计上仅在 Windows 交付路径启用。

#[cfg(target_os = "windows")]
use std::collections::HashMap;
#[cfg(target_os = "windows")]
use std::sync::Mutex;

use napi::{Error, Result, Status};
use napi_derive::napi;

// ---------------------------------------------------------------------------
// Win32 FFI（不引 winapi/windows crate，缩小依赖与攻击面）
// ---------------------------------------------------------------------------

#[cfg(target_os = "windows")]
mod win {
    // FFI 类型/常量名保持 Win32 SDK 原貌（BOOL/HANDLE/…），便于与 MSDN
    // 文档对照审读。
    #![allow(non_camel_case_types, clippy::upper_case_acronyms)]

    use core::ffi::c_void;

    pub type HANDLE = *mut c_void;
    pub type BOOL = i32;

    #[repr(C)]
    pub struct SecurityAttributes {
        pub n_length: u32,
        pub lp_security_descriptor: *mut c_void,
        pub b_inherit_handle: BOOL,
    }

    #[repr(C)]
    #[derive(Default)]
    pub struct IoCounters {
        pub read_operation_count: u64,
        pub write_operation_count: u64,
        pub other_operation_count: u64,
        pub read_transfer_count: u64,
        pub write_transfer_count: u64,
        pub other_transfer_count: u64,
    }

    /// JobObjectBasicAccountInformation（class 2）：只取 ActiveProcesses。
    /// 字段顺序与 Win32 SDK 完全一致（4 个 LARGE_INTEGER + 4 个 DWORD，
    /// x64 共 48 字节）——错位即读到别的字段（曾把 ThisPeriodTotalKernelTime
    /// 的低位误当 ActiveProcesses）。
    #[repr(C)]
    pub struct JobBasicAccountInformation {
        pub total_user_time: i64,
        pub total_kernel_time: i64,
        pub this_period_total_user_time: i64,
        pub this_period_total_kernel_time: i64,
        pub total_page_fault_count: u32,
        pub total_processes: u32,
        pub active_processes: u32,
        pub total_terminated_processes: u32,
    }

    #[repr(C)]
    pub struct JobBasicLimitInformation {
        pub per_process_user_time_limit: i64,
        pub per_job_user_time_limit: i64,
        pub limit_flags: u32,
        pub minimum_working_set_size: usize,
        pub maximum_working_set_size: usize,
        pub active_process_limit: u32,
        pub affinity: usize,
        pub priority_class: u32,
        pub scheduling_class: u32,
    }

    #[repr(C)]
    pub struct JobExtendedLimitInformation {
        pub basic: JobBasicLimitInformation,
        pub io: IoCounters,
        pub process_memory_limit: usize,
        pub job_memory_limit: usize,
        pub peak_process_memory_used: usize,
        pub peak_job_memory_used: usize,
    }

    #[repr(C)]
    pub struct JobCpuRateControlInformation {
        pub control_flags: u32,
        /// 千分比：10000 = 100%（即 1 = 0.01%）。
        pub cpu_rate: u32,
        pub weighting: u16,
        pub min_rate: u16,
        pub max_rate: u16,
    }

    pub const JOB_OBJECT_LIMIT_PROCESS_MEMORY: u32 = 0x0000_0100;
    pub const JOB_OBJECT_LIMIT_JOB_MEMORY: u32 = 0x0000_0200;
    pub const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: u32 = 0x0000_2000;
    pub const JOB_OBJECT_CPU_RATE_CONTROL_ENABLE: u32 = 0x0000_0001;

    // JOBOBJECTINFOCLASS（winnt.h）：BasicAccounting=1、BasicLimit=2、
    // ExtendedLimit=9、CpuRateControl=15。曾把 BasicAccounting 误记为 2 ——
    // 查到的是 BasicLimit（64 字节，LimitFlags=KILL_ON_JOB_CLOSE 露馅），
    // ActiveProcesses 恒为 0。
    pub const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION: i32 = 9;
    pub const JOB_OBJECT_CPU_RATE_CONTROL_INFORMATION: i32 = 15;
    pub const JOB_OBJECT_BASIC_ACCOUNT_INFORMATION: i32 = 1;

    pub const INVALID_HANDLE_VALUE: HANDLE = usize::MAX as HANDLE;

    /// AssignProcessToJobObject 需要 PROCESS_SET_QUOTA；保留 TERMINATE 便于
    /// 将来直接杀单进程（现在统一走 TerminateJobObject）。
    pub const PROCESS_SET_QUOTA: u32 = 0x0100;
    pub const PROCESS_TERMINATE: u32 = 0x0001;

    #[link(name = "kernel32")]
    extern "system" {
        pub fn CreateJobObjectW(
            lp_job_attributes: *mut SecurityAttributes,
            lp_name: *const u16,
        ) -> HANDLE;
        pub fn SetInformationJobObject(
            h_job: HANDLE,
            job_object_information_class: i32,
            lp_job_object_information: *mut c_void,
            cb_job_object_information_length: u32,
        ) -> BOOL;
        pub fn QueryInformationJobObject(
            h_job: HANDLE,
            job_object_information_class: i32,
            lp_job_object_information: *mut c_void,
            cb_job_object_information_length: u32,
            lp_return_length: *mut u32,
        ) -> BOOL;
        pub fn AssignProcessToJobObject(h_job: HANDLE, h_process: HANDLE) -> BOOL;
        pub fn OpenProcess(
            dw_desired_access: u32,
            b_inherit_handle: BOOL,
            dw_process_id: u32,
        ) -> HANDLE;
        pub fn TerminateJobObject(h_job: HANDLE, u_exit_code: u32) -> BOOL;
        pub fn CloseHandle(h_object: HANDLE) -> BOOL;
        pub fn GetLastError() -> u32;
    }
}

// ---------------------------------------------------------------------------
// 句柄表（job_id → OS 句柄）
// ---------------------------------------------------------------------------

/// Job 条目：HANDLE 以 usize 存储（裸指针非 Send，无法放 static Mutex）。
#[cfg(target_os = "windows")]
struct JobEntry {
    handle: usize,
}

/// 全局 Job 句柄表：JS 侧只拿不透明 u32 id，无法直接触摸裸 HANDLE。
#[cfg(target_os = "windows")]
static JOBS: Mutex<Option<HashMap<u32, JobEntry>>> = Mutex::new(None);
#[cfg(target_os = "windows")]
static NEXT_JOB_ID: Mutex<u32> = Mutex::new(1);

#[cfg(target_os = "windows")]
fn jobs_poisoned() -> Error {
    Error::new(Status::GenericFailure, "job 句柄表锁中毒")
}

#[cfg(target_os = "windows")]
fn jobs_locked(msg: &str) -> Error {
    Error::new(Status::GenericFailure, format!("{msg}: job 句柄表未初始化"))
}

/// 摘除式取出 Job（不存在 → Err）。操作失败时须 put_back_job 回填，
/// 杜绝半开句柄与表内漂移。
#[cfg(target_os = "windows")]
fn take_job(job_id: u32) -> Result<JobEntry> {
    let mut guard = JOBS.lock().map_err(|_| jobs_poisoned())?;
    let map = guard.as_mut().ok_or_else(|| jobs_locked("take_job"))?;
    map.remove(&job_id)
        .ok_or_else(|| Error::new(Status::GenericFailure, format!("job 不存在: {job_id}")))
}

/// 共享借用（不摘除）。handle 以 usize 传入闭包（全平台可编译）。
#[cfg(target_os = "windows")]
fn with_job<T>(job_id: u32, f: impl FnOnce(usize) -> T) -> Result<T> {
    let mut guard = JOBS.lock().map_err(|_| jobs_poisoned())?;
    let map = guard.as_mut().ok_or_else(|| jobs_locked("with_job"))?;
    match map.get(&job_id) {
        Some(entry) => Ok(f(entry.handle)),
        None => Err(Error::new(Status::GenericFailure, format!("job 不存在: {job_id}"))),
    }
}

#[cfg(target_os = "windows")]
fn put_job(entry: JobEntry) -> Result<u32> {
    let mut next = NEXT_JOB_ID.lock().map_err(|_| jobs_poisoned())?;
    let id = *next;
    *next = next.wrapping_add(1).max(1); // 永不回退到 0
    let mut guard = JOBS.lock().map_err(|_| jobs_poisoned())?;
    guard.get_or_insert_with(HashMap::new).insert(id, entry);
    Ok(id)
}

#[cfg(target_os = "windows")]
fn put_back_job(job_id: u32, entry: JobEntry) -> Result<()> {
    let mut guard = JOBS.lock().map_err(|_| jobs_poisoned())?;
    guard
        .as_mut()
        .ok_or_else(|| jobs_locked("put_back_job"))?
        .insert(job_id, entry);
    Ok(())
}

// ---------------------------------------------------------------------------
// napi 导出
// ---------------------------------------------------------------------------

/// Job 配置（全部可选，默认 KILL_ON_JOB_CLOSE 生效）。
#[napi(object)]
pub struct JobOptions {
    /// Supervisor 崩溃时 OS 自动回收 Job 内全部进程（默认 true）。
    pub kill_on_close: Option<bool>,
    /// 单进程内存硬上限（字节）。
    pub process_memory_limit_bytes: Option<f64>,
    /// 整个 Job（含孙进程）内存硬上限（字节）。
    pub job_memory_limit_bytes: Option<f64>,
    /// CPU 配额（百分比，1-100；内部换算为千分比）。
    pub cpu_rate_percent: Option<f64>,
}

#[cfg(not(target_os = "windows"))]
macro_rules! not_windows {
    () => {
        Err(Error::new(
            Status::GenericFailure,
            "job fence 仅支持 Windows（此构建使用 TS 侧 POSIX process group 回收）".to_string(),
        ))
    };
}

/// 创建 Job Object 并应用限额围栏。返回不透明 job_id。
#[cfg(target_os = "windows")]
#[napi]
pub fn create_job(opts: Option<JobOptions>) -> Result<u32> {
    use win::*;
    let opts = opts.unwrap_or(JobOptions {
        kill_on_close: None,
        process_memory_limit_bytes: None,
        job_memory_limit_bytes: None,
        cpu_rate_percent: None,
    });

    let job = unsafe { CreateJobObjectW(std::ptr::null_mut(), std::ptr::null()) };
    if job.is_null() || job == INVALID_HANDLE_VALUE {
        return Err(Error::new(Status::GenericFailure, "CreateJobObjectW 失败"));
    }

    // —— 扩展限额：内存上限 + KILL_ON_JOB_CLOSE ——
    let mut info: JobExtendedLimitInformation = unsafe { std::mem::zeroed() };
    let mut flags: u32 = 0;
    if opts.kill_on_close.unwrap_or(true) {
        flags |= JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    }
    if let Some(m) = opts.process_memory_limit_bytes {
        if m > 0.0 {
            info.process_memory_limit = m as usize;
            flags |= JOB_OBJECT_LIMIT_PROCESS_MEMORY;
        }
    }
    if let Some(m) = opts.job_memory_limit_bytes {
        if m > 0.0 {
            info.job_memory_limit = m as usize;
            flags |= JOB_OBJECT_LIMIT_JOB_MEMORY;
        }
    }
    info.basic.limit_flags = flags;
    if unsafe {
        SetInformationJobObject(
            job,
            JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
            &mut info as *mut _ as *mut _,
            std::mem::size_of::<JobExtendedLimitInformation>() as u32,
        )
    } == 0
    {
        unsafe { CloseHandle(job) };
        return Err(Error::new(
            Status::GenericFailure,
            "SetInformationJobObject(extended) 失败",
        ));
    }

    // —— CPU 配额（结构独立于 extended limits）——
    if let Some(rate) = opts.cpu_rate_percent {
        if !(1.0..=100.0).contains(&rate) {
            unsafe { CloseHandle(job) };
            return Err(Error::new(
                Status::InvalidArg,
                format!("cpu_rate_percent 须在 1-100 之间，收到 {rate}"),
            ));
        }
        let cpu = JobCpuRateControlInformation {
            control_flags: JOB_OBJECT_CPU_RATE_CONTROL_ENABLE,
            cpu_rate: (rate * 100.0).round() as u32, // 百分比 → 千分比（1% = 100）
            weighting: 0,
            min_rate: 0,
            max_rate: 0,
        };
        if unsafe {
            SetInformationJobObject(
                job,
                JOB_OBJECT_CPU_RATE_CONTROL_INFORMATION,
                &cpu as *const _ as *mut _,
                std::mem::size_of::<JobCpuRateControlInformation>() as u32,
            )
        } == 0
        {
            unsafe { CloseHandle(job) };
            return Err(Error::new(
                Status::GenericFailure,
                "SetInformationJobObject(cpu_rate) 失败",
            ));
        }
    }

    put_job(JobEntry { handle: job as usize })
}

#[cfg(not(target_os = "windows"))]
#[napi]
pub fn create_job(_opts: Option<JobOptions>) -> Result<u32> {
    not_windows!()
}

/**
 * 把一个已存在的进程（按 pid）绑入 Job 围栏。
 *
 * 调用时机：Node 侧 spawn 返回后立即调用（毫秒级窗口内）。绑定时进程
 * 可能已在运行 —— 协议层保证 host-bootstrap 收到 init 前不加载插件代码，
 * 因此围栏外的只有 Supervisor 自有的可信引导代码（见模块头注释）。
 *
 * 进程已退出（OpenProcess 失败）→ Err；绑定失败（Assign 失败）→ Err
 * （调用方须杀掉该进程并走 start-failed 状态机路径，不得放任裸奔）。
 */
#[cfg(target_os = "windows")]
#[napi]
pub fn assign_to_job(job_id: u32, pid: u32) -> Result<()> {
    use win::*;
    let entry = take_job(job_id)?;
    let process = unsafe { OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid) };
    if process.is_null() {
        let last_err = unsafe { GetLastError() };
        put_back_job(job_id, entry)?;
        return Err(Error::new(
            Status::GenericFailure,
            format!("OpenProcess({pid}) 失败（GetLastError={last_err}，进程可能已退出）"),
        ));
    }
    let assigned = unsafe { AssignProcessToJobObject(entry.handle as HANDLE, process) };
    // 进程句柄用完即关：Job 已持有自己的引用，此句柄仅用于绑定。
    unsafe { CloseHandle(process) };
    put_back_job(job_id, entry)?;
    if assigned == 0 {
        let last_err = unsafe { GetLastError() };
        return Err(Error::new(
            Status::GenericFailure,
            format!("AssignProcessToJobObject 失败（GetLastError={last_err}）"),
        ));
    }
    Ok(())
}

#[cfg(not(target_os = "windows"))]
#[napi]
pub fn assign_to_job(_job_id: u32, _pid: u32) -> Result<()> {
    not_windows!()
}

/// 终止 Job 内全部进程（含孙进程树）。幂等：job 不存在 → Err。
#[cfg(target_os = "windows")]
#[napi]
pub fn terminate_job(job_id: u32, exit_code: Option<u32>) -> Result<()> {
    let entry = take_job(job_id)?;
    let rc = unsafe { win::TerminateJobObject(entry.handle as win::HANDLE, exit_code.unwrap_or(1)) };
    put_back_job(job_id, entry)?;
    if rc == 0 {
        return Err(Error::new(
            Status::GenericFailure,
            format!("TerminateJobObject 失败: {job_id}"),
        ));
    }
    Ok(())
}

#[cfg(not(target_os = "windows"))]
#[napi]
pub fn terminate_job(_job_id: u32, _exit_code: Option<u32>) -> Result<()> {
    not_windows!()
}

/// Job 是否仍有存活进程（ActiveProcesses 计数，比 signaled 语义可靠：
/// signaled 仅在 end-of-job-time-limit 或全部退出时置位，不反映退出后状态）。
#[cfg(target_os = "windows")]
#[napi]
pub fn job_alive(job_id: u32) -> Result<bool> {
    with_job(job_id, |h| unsafe {
        let mut info: win::JobBasicAccountInformation = std::mem::zeroed();
        let ok = win::QueryInformationJobObject(
            h as win::HANDLE,
            win::JOB_OBJECT_BASIC_ACCOUNT_INFORMATION,
            &mut info as *mut _ as *mut _,
            std::mem::size_of::<win::JobBasicAccountInformation>() as u32,
            std::ptr::null_mut(),
        );
        ok != 0 && info.active_processes > 0
    })
}

#[cfg(not(target_os = "windows"))]
#[napi]
pub fn job_alive(_job_id: u32) -> Result<bool> {
    not_windows!()
}

/// 关闭 Job 句柄（触发 KILL_ON_JOB_CLOSE 时 OS 回收全部进程）。
/// 幂等：不存在 → Err（防句柄表漂移）。
#[cfg(target_os = "windows")]
#[napi]
pub fn close_job(job_id: u32) -> Result<()> {
    let entry = take_job(job_id)?;
    let rc = unsafe { win::CloseHandle(entry.handle as win::HANDLE) };
    if rc == 0 {
        put_back_job(job_id, entry)?;
        return Err(Error::new(
            Status::GenericFailure,
            format!("CloseHandle 失败: {job_id}"),
        ));
    }
    Ok(())
}

#[cfg(not(target_os = "windows"))]
#[napi]
pub fn close_job(_job_id: u32) -> Result<()> {
    not_windows!()
}

// ---------------------------------------------------------------------------
// 单测：错误路径 / 句柄泄漏 / 真实进程围栏（cargo test，无需 napi 运行时）
// ---------------------------------------------------------------------------

#[cfg(all(test, target_os = "windows"))]
mod tests {
    use super::*;
    use std::process::Command;
    use std::time::Duration;

    fn err_contains(r: Result<impl Sized>, needle: &str) -> bool {
        match r {
            Ok(_) => false,
            Err(e) => e.to_string().contains(needle),
        }
    }

    #[test]
    fn account_info_layout_matches_win32() {
        // x64：4×LARGE_INTEGER + 4×DWORD = 48 字节；ActiveProcesses 偏移 40。
        // 曾因漏掉两个 ThisPeriod* 字段把内核时间低位误读为活跃进程数。
        use win::JobBasicAccountInformation;
        assert_eq!(std::mem::size_of::<JobBasicAccountInformation>(), 48);
        let probe = JobBasicAccountInformation {
            total_user_time: 0,
            total_kernel_time: 0,
            this_period_total_user_time: 0,
            this_period_total_kernel_time: 0,
            total_page_fault_count: 0,
            total_processes: 0,
            active_processes: 0,
            total_terminated_processes: 0,
        };
        let base = &probe as *const _ as usize;
        assert_eq!(&probe.active_processes as *const u32 as usize - base, 40);
    }

    #[test]
    fn unknown_job_operations_fail() {
        assert!(err_contains(terminate_job(9_999_999, None), "不存在"));
        assert!(err_contains(close_job(9_999_999), "不存在"));
        assert!(matches!(job_alive(9_999_999), Err(_)));
        assert!(err_contains(assign_to_job(9_999_999, 4), "不存在"));
    }

    #[test]
    fn assign_missing_pid_fails_and_job_survives() {
        let job = create_job(None).expect("create_job");
        // PID 0x4（System 进程）对普通用户 OpenProcess 拒绝 → 失败但不破坏围栏
        assert!(assign_to_job(job, 4).is_err(), "不可绑定系统进程");
        assert!(!job_alive(job).expect("alive"), "空 Job 不得有活跃进程");
        close_job(job).expect("close");
        assert!(err_contains(close_job(job), "不存在"), "重复 close 必须报错（句柄已回收）");
    }

    #[test]
    fn assign_binds_and_terminate_reaps() {
        let job = create_job(Some(JobOptions {
            kill_on_close: Some(true),
            process_memory_limit_bytes: Some(512.0 * 1024.0 * 1024.0),
            job_memory_limit_bytes: None,
            cpu_rate_percent: None,
        }))
        .expect("create_job");
        // ping -n 30：约 30 秒的长驻进程，测试内来得及绑定与终止
        let mut child = Command::new("C:\\Windows\\System32\\ping.exe")
            .args(["-n", "30", "127.0.0.1"])
            .spawn()
            .expect("spawn ping");
        let pid = child.id();
        assign_to_job(job, pid).expect("assign");
        assert!(job_alive(job).expect("alive"), "绑定后 Job 内必须有活跃进程");
        terminate_job(job, Some(7)).expect("terminate");
        for _ in 0..50 {
            if !job_alive(job).expect("alive") {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(!job_alive(job).expect("alive"), "terminate 后 Job 内不得有存活进程");
        let _ = child.wait(); // 回收僵尸（TerminateJobObject 已杀掉它）
        close_job(job).expect("close");
    }

    #[test]
    fn close_job_kills_on_close_processes() {
        // KILL_ON_JOB_CLOSE 语义：句柄一关，进程随之被 OS 回收。
        let job = create_job(Some(JobOptions {
            kill_on_close: Some(true),
            process_memory_limit_bytes: None,
            job_memory_limit_bytes: None,
            cpu_rate_percent: None,
        }))
        .expect("create_job");
        let mut child = Command::new("C:\\Windows\\System32\\ping.exe")
            .args(["-n", "30", "127.0.0.1"])
            .spawn()
            .expect("spawn ping");
        assign_to_job(job, child.id()).expect("assign");
        close_job(job).expect("close");
        for _ in 0..50 {
            if child.try_wait().expect("try_wait").is_some() {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(
            child.try_wait().expect("try_wait").is_some(),
            "close（KILL_ON_JOB_CLOSE）后进程必须已被 OS 回收"
        );
    }

    #[test]
    fn cpu_rate_validation() {
        let bad = create_job(Some(JobOptions {
            kill_on_close: None,
            process_memory_limit_bytes: None,
            job_memory_limit_bytes: None,
            cpu_rate_percent: Some(0.0),
        }));
        assert!(err_contains(bad, "cpu_rate_percent"));
    }
}
