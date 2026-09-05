// 安全中心：实例健康体检（doctor）、crash-guard 状态、插件隔离区、profile 快照回滚、
// 版本备份回退。所有保护性操作均可逆（隔离可恢复、快照可回滚、版本备份对称换位）。

import { h } from "../ui/dom";
import { ico } from "../ui/icons";
import { api, sys } from "../core/api";
import { state, setState, subscribe } from "../core/store";
import { fmtDate, relTime } from "../core/format";
import type { DoctorCheck, InstanceMeta, PluginSnapshot } from "../core/types";
import { toast, confirmModal } from "../ui/feedback";
import { refreshCurrentView } from "../app";

export function renderSafety(host: HTMLElement): () => void {
  let selId: string | null = state.instances[0]?.id ?? null;
  let checks: DoctorCheck[] | null = null;
  let checksLoading = false;
  let unsub: () => void;

  const build = () => {
    host.innerHTML = "";
    const n = state.instances.length;
    const quar = state.instances.reduce((s, i) => s + (i.quarantine?.length ?? 0), 0);
    const updatable = state.instances.filter((i) => i.updateAvailable).length;
    const head = h("div", { class: "page-head" },
      h("div", { class: "ghostly" }, "SAF"),
      h("div", { class: "row" },
        h("div", {},
          h("h1", {}, "安全中心"),
          h("div", { class: "sub" }, "体检 · 崩溃守卫 · 插件隔离与回滚 · 版本备份"),
        ),
        h("div", { class: "spacer" }),
        h("button", {
          class: "btn",
          onClick: () => void doCheckUpdates(),
        }, ico("refresh"), "检查全部更新"),
      ),
      h("div", { class: "rule" }),
      h("div", { class: "safety-stats" },
        statBlock(String(n), "受管实例"),
        statBlock(String(quar), "隔离中插件", quar > 0 ? "warn" : undefined),
        statBlock(String(updatable), "可升级", updatable > 0 ? "warn" : undefined),
        statBlock(crashGuarded().toString(), "crash-guard 关注", crashGuarded() > 0 ? "err" : undefined),
      ),
    );
    const body = h("div", { class: "page-body" });
    host.append(head, body);

    if (state.instances.length === 0) {
      body.append(h("div", { class: "empty-frame" },
        h("div", { class: "big" }, "SAFE"),
        h("h3", {}, "没有实例"),
        h("p", {}, "创建或导入实例后，可在这里进行健康体检与安全恢复。"),
      ));
      return;
    }

    // 实例选择器
    const sel = h("select", { class: "input", style: { maxWidth: "360px" }, onChange: () => {
      selId = (sel as HTMLSelectElement).value;
      checks = null;
      build();
    } }) as HTMLSelectElement;
    for (const i of state.instances) {
      const opt = h("option", { value: i.id }, `${i.name} · ${i.tag}`) as HTMLOptionElement;
      opt.value = i.id;
      opt.selected = i.id === selId;
      sel.append(opt);
    }
    body.append(h("div", { class: "search-line", style: { marginBottom: "16px" } },
      h("span", { class: "mono faint" }, "选择实例"),
      sel,
    ));
    const holder = h("div", {});
    body.append(holder);
    drawInstanceInto(holder);
  };

  const crashGuarded = () =>
    state.instances.filter((i) => (i.failStreak ?? 0) >= 2).length;

  const statBlock = (num: string, label: string, tone?: string) =>
    h("div", { class: `stat-block ${tone ?? ""}` },
      h("div", { class: "num mono" }, num),
      h("div", { class: "lbl" }, label),
    );

  const drawInstanceInto = (holder: HTMLElement) => {
    holder.innerHTML = "";
    const inst = state.instances.find((i) => i.id === selId);
    if (!inst) {
      holder.append(h("p", { class: "mono faint" }, "实例不存在"));
      return;
    }
    holder.append(
      crashGuardBlock(inst),
      versionSafetyBlock(inst),
      doctorBlock(inst),
      quarantineBlock(inst),
      snapshotBlock(),
    );
    void loadDoctor(inst);
    void loadSnapshots(inst);
  };

  // ---- crash-guard / 诊断 ----
  const crashGuardBlock = (inst: InstanceMeta): HTMLElement => {
    const streak = inst.failStreak ?? 0;
    const level = streak >= 3 ? "err" : streak >= 1 ? "warn" : "ok";
    const title = streak === 0
      ? "启动链路健康（无连败记录）"
      : `启动连败 ${streak} 次${streak >= 3 ? " · crash-guard 已介入" : ""}`;
    return h("div", { class: "panel" },
      h("div", { class: "panel-head" },
        h("h3", {}, "崩溃守卫"),
        h("span", { class: `chip ${level === "err" ? "danger" : level === "warn" ? "" : "on"}` },
          level === "err" ? "CRASH-GUARD" : level === "warn" ? "观察中" : "正常"),
      ),
      h("p", { class: "mono dim", style: { fontSize: "12px", lineHeight: "1.8", whiteSpace: "pre-wrap" } },
        inst.lastFailReason ?? title),
      h("div", { style: { display: "flex", gap: "10px", marginTop: "14px", flexWrap: "wrap" } },
        h("button", {
          class: "btn small solid",
          onClick: () => void doSafeLaunch(inst),
          disabled: !!state.running[inst.id],
        }, ico("play"), "安全启动（先隔离全部第三方插件）"),
        h("button", {
          class: "btn small",
          onClick: () => void doFix(inst, "safe_recovery"),
        }, ico("shield"), "一键安全恢复"),
        h("button", {
          class: "btn small ghost",
          onClick: () => void sys.reveal(inst.dir + "\\launcher-shell.log").catch(() => toast("暂无日志", "该实例还没有启动日志", "info")),
        }, ico("folder"), "启动日志"),
      ),
      h("p", { class: "mono faint", style: { fontSize: "11px", marginTop: "12px", lineHeight: "1.7" } },
        "连败 ≥3 次时 crash-guard 自动隔离全部第三方插件并修复 bundles（均可逆）。安全启动 = 先隔离再拉起，用于确认是否插件导致后端崩溃。"),
    );
  };

  // ---- 版本安全（升级/回退/备份） ----
  const versionSafetyBlock = (inst: InstanceMeta): HTMLElement => {
    const ops = h("div", { style: { display: "flex", gap: "10px", marginTop: "14px", flexWrap: "wrap" } });
    if (inst.updateAvailable && inst.origin !== "imported") {
      ops.append(h("button", {
        class: "btn small solid",
        onClick: () => void doUpgrade(inst),
        disabled: !!state.running[inst.id],
      }, ico("up"), `升级到 ${inst.updateAvailable}（保留数据与插件）`));
    }
    ops.append(h("button", {
      class: "btn small",
      onClick: () => void doPickVersion(inst),
    }, ico("list"), "选择版本安装（可降级）"));
    ops.append(h("button", {
      class: "btn small",
      onClick: () => void doRollback(inst),
      disabled: !!state.running[inst.id],
    }, ico("undo"), "回退到备份版本"));
    return h("div", { class: "panel" },
      h("div", { class: "panel-head" },
        h("h3", {}, "版本安全"),
        h("span", { class: "chip on" }, inst.tag),
        inst.updateAvailable ? h("span", { class: "chip" , style: { borderColor: "var(--warn)", color: "var(--warn)" } }, `可升级 ${inst.updateAvailable}`) : null,
      ),
      h("p", { class: "mono dim", style: { fontSize: "12px", lineHeight: "1.8" } },
        `升级/降级只替换程序目录（app），DSH_HOME 数据与插件原样保留；旧版本自动存为 app.bak-*，可一键对称回退。`),
      ops,
    );
  };

  // ---- doctor 体检 ----
  const doctorBlock = (inst: InstanceMeta): HTMLElement => {
    const holder = h("div", {});
    if (checksLoading && !checks) {
      holder.append(h("p", { class: "mono faint", style: { fontSize: "12px" } }, "体检中…"));
    } else if (checks) {
      checks.forEach((c) => {
        const dot = c.level === "ok" ? "run" : c.level === "warn" ? "installing" : "err";
        holder.append(h("div", { class: "check-row" },
          h("i", { class: `dot ${dot}`, style: { marginTop: "5px" } }),
          h("div", { style: { flex: 1 } },
            h("div", { class: "p-name" }, c.title),
            h("div", { class: "p-desc mono", style: { color: c.level === "err" ? "var(--danger)" : undefined } }, c.detail),
          ),
          c.fix ? h("button", {
            class: "btn small ghost",
            onClick: () => void doFix(inst, c.fix!),
          }, "一键修复") : null,
        ));
      });
    }
    return h("div", { class: "panel" },
      h("div", { class: "panel-head" },
        h("h3", {}, "健康体检"),
        h("div", { class: "spacer" }),
        h("button", { class: "btn small ghost", onClick: () => { checks = null; refresh(); void loadDoctor(inst); } },
          ico("refresh"), "重新体检"),
      ),
      holder,
    );
  };

  // ---- 隔离区 ----
  const quarantineBlock = (inst: InstanceMeta): HTMLElement => {
    const items = inst.quarantine ?? [];
    const holder = h("div", {});
    if (items.length === 0) {
      holder.append(h("p", { class: "mono faint", style: { fontSize: "12px" } },
        "隔离区为空。crash-guard 介入或安全启动后，被移出的插件会出现在这里，可恢复或彻底删除。"));
    }
    items.forEach((q) => {
      holder.append(h("div", { class: "plug-row" },
        h("div", {},
          h("div", { class: "p-name" }, q.name,
            h("span", { class: "chip" }, `v${q.version || "?"}`),
            h("span", { class: "chip", style: { borderColor: "var(--warn)", color: "var(--warn)" } }, reasonLabel(q.reason)),
          ),
          h("div", { class: "p-desc mono" }, `${q.id} · 隔离于 ${relTime(q.at)}`),
        ),
        h("div", { class: "m-ops" },
          h("button", {
            class: "btn small ghost",
            onClick: async () => {
              try {
                await api.quarantineRestore(inst.id, q.name);
                toast("已恢复", q.name);
                await refreshInstances();
                refresh();
              } catch (e) { toast("恢复失败", String(e), "err"); }
            },
          }, "恢复"),
          h("button", {
            class: "btn small ghost danger",
            onClick: async () => {
              const ok = await confirmModal({
                title: "彻底删除插件",
                body: `${q.name}\n\n将从隔离区永久删除（不删除插件数据之外的内容）。`,
                confirmText: "永久删除", danger: true,
              });
              if (!ok) return;
              try {
                await api.quarantinePurge(inst.id, q.name);
                toast("已删除", q.name);
                await refreshInstances();
                refresh();
              } catch (e) { toast("删除失败", String(e), "err"); }
            },
          }, ico("trash"), "删除"),
        ),
      ));
    });
    return h("div", { class: "panel" },
      h("div", { class: "panel-head" },
        h("h3", {}, "插件隔离区"),
        h("span", { class: "chip" }, `${items.length} 项`),
      ),
      holder,
    );
  };

  // ---- profile 快照 ----
  const snapshotBlock = (): HTMLElement => {
    const holder = h("div", { id: "snap-holder" });
    holder.append(h("p", { class: "mono faint", style: { fontSize: "12px" } }, "加载快照中…"));
    return h("div", { class: "panel" },
      h("div", { class: "panel-head" },
        h("h3", {}, "插件快照回滚"),
        h("span", { class: "mono faint", style: { fontSize: "11px" } }, "安装/卸载/停用前自动快照，保留最近 20 份"),
      ),
      holder,
    );
  };

  const drawSnapshots = (inst: InstanceMeta, snaps: PluginSnapshot[]) => {
    const holder = host.querySelector("#snap-holder");
    if (!holder) return;
    holder.innerHTML = "";
    if (snaps.length === 0) {
      holder.append(h("p", { class: "mono faint", style: { fontSize: "12px" } },
        "还没有快照（首次安装/卸载/停用插件时自动创建）。"));
      return;
    }
    snaps.forEach((s) => {
      holder.append(h("div", { class: "plug-row" },
        h("div", {},
          h("div", { class: "p-name mono" }, `snap-${s.ts}`,
            h("span", { class: "chip" }, `${s.deps} 依赖`),
          ),
          h("div", { class: "p-desc mono" }, `${s.reason || "手动"} · ${fmtDate(s.ts)}`),
        ),
        h("div", { class: "m-ops" },
          h("button", {
            class: "btn small",
            disabled: !!state.running[inst.id],
            onClick: async () => {
              const ok = await confirmModal({
                title: "回滚插件 profile",
                body: `将把插件清单与依赖恢复到 ${fmtDate(s.ts)} 的状态（快照含 ${s.deps} 个依赖）：\n\n${s.reason}`,
                confirmText: "回滚",
              });
              if (!ok) return;
              try {
                await api.restoreSnapshot(inst.id, s.ts);
                toast("回滚完成", "插件 profile 已恢复");
                await refreshInstances();
                refresh();
              } catch (e) { toast("回滚失败", String(e), "err"); }
            },
          }, ico("undo"), "回滚到此"),
        ),
      ));
    });
  };

  const loadSnapshots = async (inst: InstanceMeta) => {
    try {
      const snaps = await api.pluginSnapshots(inst.id);
      if (inst.id === selId) drawSnapshots(inst, snaps);
    } catch { /* 静默 */ }
  };

  const loadDoctor = async (inst: InstanceMeta) => {
    if (checksLoading) return;
    checksLoading = true;
    try {
      const c = await api.getDoctor(inst.id);
      if (inst.id === selId) {
        checks = c;
        refresh();
      }
    } catch (e) {
      toast("体检失败", String(e), "err");
    } finally {
      checksLoading = false;
    }
  };

  const reasonLabel = (r: string) => {
    const map: Record<string, string> = {
      "crash-guard": "崩溃守卫",
      "safe-launch": "安全启动",
      manual: "手动隔离",
      "manual-recovery": "安全恢复",
    };
    return map[r] ?? r;
  };

  // ---- 动作 ----
  const doCheckUpdates = async () => {
    toast("检查更新", "正在对比上游 Release…", "info");
    try {
      await api.checkUpdates();
      await refreshInstances();
      refresh();
      const up = state.instances.filter((i) => i.updateAvailable);
      if (up.length > 0) {
        toast("发现新版本", up.map((i) => `${i.name} → ${i.updateAvailable}`).join("，"), "info");
      } else {
        toast("已是最新", "所有实例均为上游最新版本");
      }
    } catch (e) {
      toast("检查失败", String(e), "err");
    }
  };

  const doSafeLaunch = async (inst: InstanceMeta) => {
    try {
      await api.launchInstance(inst.id, true);
      toast("安全启动", `${inst.name} 已隔离第三方插件并拉起，窗口稍后弹出`);
      setState({ running: { ...state.running, [inst.id]: true } });
    } catch (e) {
      toast("启动失败", String(e), "err");
    }
  };

  const doFix = async (inst: InstanceMeta, check: string) => {
    try {
      const msg = await api.doctorFix(inst.id, check);
      toast("修复完成", msg);
      checks = null;
      await refreshInstances();
      refresh();
      void loadDoctor(inst);
    } catch (e) {
      toast("修复失败", String(e), "err");
    }
  };

  const doUpgrade = async (inst: InstanceMeta) => {
    try {
      const list = await api.listEditions(inst.edition);
      const target = list.find((e) => e.tag === inst.updateAvailable);
      if (!target) {
        toast("未找到产物", `上游目录中没有 ${inst.updateAvailable} 的可用产物`, "err");
        return;
      }
      await api.upgradeInstance(inst.id, target);
      toast("升级已开始", `${inst.name} → ${target.tag}，完成后自动刷新`);
      refreshCurrentView();
    } catch (e) {
      toast("升级失败", String(e), "err");
    }
  };

  const doPickVersion = async (inst: InstanceMeta) => {
    try {
      const list = (await api.listEditions(inst.edition)).filter((e) => e.edition === inst.edition);
      const { pickEditionModal } = await import("../ui/feedback");
      const picked = await pickEditionModal(inst.name, list);
      if (!picked) return;
      if (picked.tag === inst.tag) {
        toast("版本相同", `当前已是 ${picked.tag}`, "info");
        return;
      }
      await api.upgradeInstance(inst.id, picked);
      toast("版本切换已开始", `${inst.name} → ${picked.tag}`);
    } catch (e) {
      toast("操作失败", String(e), "err");
    }
  };

  const doRollback = async (inst: InstanceMeta) => {
    try {
      const msg = await api.rollbackInstance(inst.id);
      toast("回退完成", msg);
      await refreshInstances();
      checks = null;
      refresh();
    } catch (e) {
      toast("回退失败", String(e), "err");
    }
  };

  const refreshInstances = async () => {
    const c = await api.getState();
    setState({ instances: c.instances });
  };

  const refresh = () => build();
  build();
  // 实例数据变化（隔离区更新、升级完成、崩溃守卫介入）时轻量重绘
  let sig = JSON.stringify(state.instances.map((i) => [i.id, i.failStreak, i.updateAvailable, i.quarantine?.length, i.version]));
  unsub = subscribe(() => {
    const next = JSON.stringify(state.instances.map((i) => [i.id, i.failStreak, i.updateAvailable, i.quarantine?.length, i.version]));
    if (next !== sig) {
      sig = next;
      build();
    }
  });
  return () => { unsub(); };
}
