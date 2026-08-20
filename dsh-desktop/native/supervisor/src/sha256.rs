//! 流式 SHA-256（spec F1.1）：64KB 分块，常量内存，跨平台。
//!
//! 用途：插件包内容哈希（installer 的 hashTree 热路径）。相比 Node 逐文件
//! `crypto.createHash`，本实现少一次 JS↔V8 边界往返，且可被任一侧复用。

use std::io::Read;

use napi::bindgen_prelude::Buffer;
use napi::{Error, Result, Status};
use napi_derive::napi;
use sha2::{Digest, Sha256};

/// 单次读盘块大小（64KB：顺序 IO 吞吐与内存占用的平衡点）。
const CHUNK: usize = 64 * 1024;

/// 计算文件 SHA-256，返回小写 hex。跨平台可用。
#[napi]
pub fn sha256_stream(path: String) -> Result<String> {
    let mut file = std::fs::File::open(&path)
        .map_err(|e| Error::new(Status::GenericFailure, format!("打开失败 {path}: {e}")))?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; CHUNK];
    loop {
        let n = file
            .read(&mut buf)
            .map_err(|e| Error::new(Status::GenericFailure, format!("读取失败 {path}: {e}")))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    let out = hasher.finalize();
    Ok(out.iter().map(|b| format!("{b:02x}")).collect())
}

/// 字节串 SHA-256（小写 hex）：小对象（清单、清单哈希）用。
#[napi]
pub fn sha256_bytes_hex(data: Buffer) -> Result<String> {
    let mut hasher = Sha256::new();
    hasher.update(data.as_ref());
    let out = hasher.finalize();
    Ok(out.iter().map(|b| format!("{b:02x}")).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// FIPS 180-4 已知向量：空串。
    const EMPTY_HEX: &str = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    /// FIPS 180-4 已知向量："abc"。
    const ABC_HEX: &str = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

    #[test]
    fn known_vectors_bytes() {
        let empty = sha256_bytes_hex(Buffer::from(Vec::new())).expect("empty");
        assert_eq!(empty, EMPTY_HEX);
        let abc = sha256_bytes_hex(Buffer::from(b"abc".to_vec())).expect("abc");
        assert_eq!(abc, ABC_HEX);
    }

    #[test]
    fn known_vector_file_stream() {
        let dir = std::env::temp_dir().join("dsh-supervisor-native-test");
        std::fs::create_dir_all(&dir).expect("mkdir");
        let p = dir.join("sha256-stream-abc.bin");
        std::fs::write(&p, b"abc").expect("write");
        let hex = sha256_stream(p.to_string_lossy().to_string()).expect("hash");
        assert_eq!(hex, ABC_HEX);
        std::fs::remove_file(&p).ok();
    }

    #[test]
    fn large_file_matches_chunked_path() {
        // 200KB（跨多个 64KB 块）与一次性 hash 等价
        let data: Vec<u8> = (0..200 * 1024u32).map(|i| (i % 251) as u8).collect();
        let dir = std::env::temp_dir().join("dsh-supervisor-native-test");
        std::fs::create_dir_all(&dir).expect("mkdir");
        let p = dir.join("sha256-stream-200k.bin");
        std::fs::write(&p, &data).expect("write");
        let stream_hex = sha256_stream(p.to_string_lossy().to_string()).expect("stream");
        let whole_hex = sha256_bytes_hex(Buffer::from(data)).expect("whole");
        assert_eq!(stream_hex, whole_hex);
        std::fs::remove_file(&p).ok();
    }

    #[test]
    fn missing_file_errors() {
        let r = sha256_stream("Z:\\definitely\\not\\exist.bin".into());
        assert!(r.is_err());
    }
}
