// 安装向导：欢迎 → 选版本&命名 → 下载安装 → 完成。
// 首次运行模式（含目录选择）/ 新建实例模式（跳过目录步骤）。

import { h } from "../ui/dom";
import { ico } from "../ui/icons";
import { api, sys } from "../core/api";
import { state, setState } from "../core/store";
import { fmtBytes, fmtIsoDate, pct } from "../core/format";
import type { EditionInfo, InstanceMeta } from "../core/types";
import { toast, confirmModal, promptModal } from "../ui/feedback";
import { refreshCurrentView } from "../app";

type StepId = "welcome" | "edition" | "install" | "done";

export function openWizard(mode: "first" | "add"): () => void {
  const steps: { id: StepId; label: string }[] =
    mode === "first"
      ? [
          { id: "welcome", label: "欢迎" },
          { id: "edition", label: "版本" },
          { id: "install", label: "安装" },
          { id: "done", label: "完成" },
        ]
      : [
          { id: "edition", label: "版本" },
          { id: "install", label: "安装" },
          { id: "done", label: "完成" },
        ];

  let step: StepId = steps[0].id;
  let chosen: EditionInfo | null = null;
  let instName = "";
  let installTaskId: string | null = null;
  let finalName = "";

  const root = h("div", { class: "onboard" });
  const body = h("div", { class: "o-body" });
  const stepsEl = h("div", { class: "o-steps" });
  const foot = h("div", { class: "o-foot" });

  const close = () => root.remove();
  const head = h("div", { class: "o-head" },
    stepsEl,
    h("div", { style: { display: "flex", gap: "10px", alignItems: "center" } },
      mode === "add" ? h("button", { class: "btn ghost small", onClick: () => { cleanupClose(); } }, "稍后再说") : null,
      h("span", { class: "mono faint" }, "EAC SETUP"),
    ),
  );
  root.append(head, body, foot);
  document.body.append(root);

  const cleanupClose = () => {
    if (installTaskId) {
      void api.cancelTask(installTaskId).catch(() => undefined);
    }
    close();
    refreshCurrentView();
  };

  const goto = (s: StepId) => {
    step = s;
    drawSteps();
    drawPage();
  };

  const drawSteps = () => {
    stepsEl.innerHTML = "";
    steps.forEach((s, i) => {
      const idx = steps.findIndex((x) => x.id === step);
      const cls = s.id === step ? "cur" : i < idx ? "done" : "";
      stepsEl.append(h("div", { class: `o-step ${cls}` }, h("i"), s.label));
      if (i < steps.length - 1) stepsEl.append(h("div", { class: "o-step" }, h("span", { class: "dash" })));
    });
  };

  const drawPage = () => {
    body.innerHTML = "";
    const page = h("div", { class: "o-page enter" });
    if (step === "welcome") pageWelcome(page);
    else if (step === "edition") pageEdition(page);
    else if (step === "install") pageInstall(page);
    else pageDone(page);
    body.append(page);
    drawFoot();
  };

  const drawFoot = () => {
    foot.innerHTML = "";
    if (step === "welcome") {
      foot.append(
        h("span", { class: "hint" }, "数据存储于每个实例独立的 DSH_HOME，卸载实例不会影响其他实例。"),
        h("div", { class: "sp" }),
        h("button", { class: "btn ghost", onClick: skipAll }, "跳过，稍后手动安装"),
        h("button", { class: "btn solid", onClick: () => goto("edition") }, "下一步", ico("arrow")),
      );
    } else if (step === "edition") {
      foot.append(
        h("span", { class: "hint" }, "完整版为便携包解压（约 200MB）· Lite 为静默安装（约 76MB）"),
        h("div", { class: "sp" }),
        h("button", {
          class: "btn solid",
          disabled: !chosen || instName.trim().length === 0,
          onClick: () => void startInstall(),
        }, "开始下载安装", ico("download")),
      );
    } else if (step === "install") {
      foot.append(
        h("span", { class: "hint" }, "下载支持断点续传，关闭窗口不会损坏已下载数据。"),
      );
    } else {
      foot.append(
        h("div", { class: "sp" }),
        h("button", { class: "btn solid", onClick: () => void finish() }, "进入实例库", ico("arrow")),
      );
    }
  };

  const skipAll = async () => {
    if (mode === "first" && state.settings) {
      await api.setSettings({ ...state.settings, onboarded: true });
      setState({ settings: { ...state.settings, onboarded: true } });
    }
    cleanupClose();
    if (mode === "first") location.reload();
  };

  const finish = async () => {
    if (mode === "first" && state.settings) {
      await api.setSettings({ ...state.settings, onboarded: true });
      setState({ settings: { ...state.settings, onboarded: true } });
    }
    cleanupClose();
    if (mode === "first") location.reload();
  };

  // ---- Step 1: 欢迎 ----
  const pageWelcome = (page: HTMLElement) => {
    const rootInput = h("input", {
      class: "input",
      value: state.settings?.instanceRoot ?? "",
      readOnly: true,
      style: { maxWidth: "480px" },
    }) as HTMLInputElement;
    page.append(
      h("div", { class: "o-title" },
        "揽尽万象。", h("br"),
        h("span", { class: "serif" }, "Embracing All Creation"),
      ),
      h("div", { class: "o-sub" },
        "这是 DSH EAC 的多实例启动器。你可以为「完整版」与「Lite 版」创建任意多个互相隔离的实例，按需安装插件，并排运行。版本产物实时从上游 GitHub Releases 获取。"),
      h("div", { class: "field", style: { marginTop: "40px", maxWidth: "480px" } },
        h("label", {}, "实例存储目录"),
        h("div", { style: { display: "flex", gap: "10px", alignItems: "flex-end" } },
          rootInput,
          h("button", {
            class: "btn small",
            onClick: async () => {
              const picked = await sys.pickFolder("选择实例存储目录", state.settings?.instanceRoot ?? "");
              if (picked && state.settings) {
                await api.setSettings({ ...state.settings, instanceRoot: picked });
                setState({ settings: { ...state.settings, instanceRoot: picked } });
                rootInput.value = picked;
              }
            },
          }, "浏览"),
        ),
      ),
    );
  };

  // ---- Step 2: 版本选择 ----
  const pageEdition = (page: HTMLElement) => {
    page.append(
      h("div", { class: "o-title" }, "选择版本，", h("span", { class: "serif" }, "起个名字")),
      h("div", { class: "o-sub" }, "产物信息实时解析自 zouyuxuan122/DSH-Desktop-EAC。默认最新版；点版本徽章可切换历史版本（降级）。"),
    );
    const grid = h("div", { class: "ed-grid" });
    page.append(grid);

    // 版本历史行（默认收起）
    let history: EditionInfo[] = [];
    let historyOpen = false;
    const historyRow = h("div", { style: { marginTop: "14px", maxWidth: "480px" } });
    const drawHistory = () => {
      historyRow.innerHTML = "";
      if (historyOpen && history.length > 0) {
        history.forEach((e) => {
          historyRow.append(h("button", {
            class: `pick-row ${chosen?.tag === e.tag ? "sel" : ""}`,
            onClick: () => {
              chosen = e;
              if (!instName) {
                instName = e.edition === "lite" ? "轻量实例" : "主力实例";
                nameInput.value = instName;
              }
              renderCards();
              drawHistory();
              drawFoot();
            },
          },
            h("span", { class: "mono", style: { fontWeight: 600 } }, e.tag),
            h("span", { class: "mono faint", style: { fontSize: "11px" } },
              `${fmtBytes(e.asset.size)} · ${fmtIsoDate(e.publishedAt)}`),
          ));
        });
      } else if (history.length > 1) {
        historyRow.append(h("button", {
          class: "btn small ghost",
          onClick: () => { historyOpen = true; drawHistory(); },
        }, ico("list"), `历史版本（${history.length} 个，可降级）`));
      }
    };
    page.append(historyRow);

    const nameField = h("div", { class: "field", style: { marginTop: "26px", maxWidth: "480px" } });
    page.append(nameField);
    const nameInput = h("input", {
      class: "input",
      placeholder: "实例名称，例如：主力 · 完整版",
      value: instName,
      onInput: () => {
        instName = (nameInput as HTMLInputElement).value;
        drawFoot();
      },
    }) as HTMLInputElement;
    nameField.append(h("label", {}, "实例名称"), nameInput);

    const renderCards = () => {
      grid.innerHTML = "";
      if (state.editionsState === "loading" || state.editionsState === "idle") {
        for (let i = 0; i < 2; i++) {
          grid.append(h("div", { class: "ed-card loading" },
            h("div", { class: "e-tag" }, "FETCHING…"),
            h("div", { class: "e-ver faint" }, "···"),
          ));
        }
        return;
      }
      if (state.editionsState === "error") {
        grid.append(h("div", { class: "ed-card", style: { gridColumn: "1 / -1", cursor: "default" } },
          h("div", { class: "e-tag", style: { color: "var(--danger)" } }, "无法获取版本目录"),
          h("p", { style: { marginTop: "10px", color: "var(--paper-dim)", fontSize: "12px", lineHeight: "1.7" } },
            state.editionsError),
          h("button", { class: "btn small", style: { marginTop: "14px" }, onClick: () => void loadEditions() },
            ico("refresh"), "重试"),
        ));
        return;
      }
      for (const ed of state.editions) {
        const sel = chosen?.edition === ed.edition;
        const card = h("button", {
          class: `ed-card ${sel ? "sel" : ""}`,
          onClick: () => {
            chosen = ed;
            if (!instName) {
              instName = ed.edition === "lite" ? "轻量实例" : "主力实例";
              nameInput.value = instName;
            }
            renderCards();
            drawFoot();
            // 切 edition 后刷新历史列表
            void (async () => {
              try {
                const all = await api.listEditions(ed.edition);
                history = all.filter((e) => e.edition === ed.edition);
                drawHistory();
              } catch { /* 离线时隐藏历史 */ }
            })();
          },
        },
          h("div", { class: "corner" }, h("span", { innerHTML: ico("check").innerHTML })),
          h("div", { class: "e-tag" }, ed.edition === "lite" ? "LITE · TAURI" : "FULL · COMPLETE"),
          h("h3", {}, ed.edition === "lite" ? "Lite 轻量版" : "完整版"),
          h("div", { class: "e-ver" }, ed.tag),
          h("div", { class: "e-meta" },
            h("span", {}, fmtBytes(ed.asset.size)),
            h("span", {}, fmtIsoDate(ed.publishedAt)),
          ),
          h("div", { class: "e-note" },
            ed.edition === "lite"
              ? "Tauri 轻量壳，资源占用低，适合快速上手与多开。"
              : "内置 Node 运行时与 dsh 内核的全功能桌面客户端。",
          ),
        );
        grid.append(card);
      }
    };
    renderCards();
    void loadEditions().then(() => {
      renderCards();
      void (async () => {
        try {
          const all = await api.listEditions();
          history = all.filter((e) => (chosen ? e.edition === chosen.edition : e.edition === "full"));
          drawHistory();
        } catch { /* 离线时隐藏历史 */ }
      })();
    });
  };

  const loadEditions = async () => {
    if (state.editionsState === "loading") return;
    setState({ editionsState: "loading", editionsError: "" });
    try {
      const list = await api.resolveEditions();
      setState({ editions: list, editionsState: "ok" });
    } catch (e) {
      setState({ editionsState: "error", editionsError: String(e) });
      toast("版本目录获取失败", String(e), "err");
    }
  };

  // ---- Step 3: 安装 ----
  const pageInstall = (page: HTMLElement) => {
    if (!chosen) { goto("edition"); return; }
    const asset = chosen.asset;
    const pctEl = h("div", { class: "pct" }, "0");
    const bar = h("div", { class: "bar" }, h("i"));
    const msgEl = h("span", { class: "mono dim" }, "准备中");
    const spdEl = h("span", {}, "— /s");
    const szEl = h("span", {}, `0 B / ${fmtBytes(asset.size)}`);

    const stageIds = ["download", "verify", "extract", "done"];
    const stageNames: Record<string, string> = {
      download: "下载产物",
      verify: "SHA256 校验",
      extract: "解压 / 静默安装",
      done: "发现主程序",
    };
    // 后端阶段 → 清单行：install（NSIS）与 extract 同属第三步
    const stageRow: Record<string, number> = {
      download: 0,
      verify: 1,
      extract: 2,
      install: 2,
      done: 3,
    };
    const stageRows = new Map<string, HTMLElement>();
    const list = h("div", { class: "stage-list" });
    for (const sid of stageIds) {
      const rowEl = h("div", { class: "stage-item", "data-stage": sid },
        h("span", { class: "s-idx mono" }, String(stageIds.indexOf(sid) + 1).padStart(2, "0")),
        h("span", {}, stageNames[sid]),
        h("span", { class: "s-msg" }, ""),
      );
      stageRows.set(sid, rowEl);
      list.append(rowEl);
    }

    page.append(
      h("div", { class: "o-title" }, "安装 ", h("span", { class: "serif" }, instName || "新实例")),
      h("div", { class: "readout" },
        pctEl,
        h("span", { class: "unit" }, "% · " + asset.name),
      ),
      h("div", { style: { maxWidth: "520px", marginTop: "24px" } }, bar),
      h("div", { style: { display: "flex", gap: "22px", marginTop: "16px", fontFamily: "var(--font-mono)", fontSize: "11px", color: "var(--paper-dim)" } },
        msgEl, spdEl, szEl,
      ),
      list,
    );

    let settledHandled = false;
    const tick = () => {
      if (step !== "install" || !document.body.contains(page)) return;
      const t = state.tasks.find((x) => x.id === installTaskId);
      if (t) {
        const settled = t.state === "done" || t.state === "error" || t.state === "cancelled";
        if (!settled) {
          const p = t.total > 0 ? Math.floor(pct(t.received, t.total)) : 0;
          pctEl.textContent = t.stage !== "download" ? "···" : String(p);
          (bar.firstChild as HTMLElement).style.width = t.stage === "download" ? `${p}%` : "34%";
          bar.classList.toggle("indeterminate", t.stage !== "download");
          msgEl.textContent = t.message;
          msgEl.style.color = "";
          spdEl.textContent = t.stage === "download" ? `${fmtBytes(t.speedBps)}/s` : "";
          szEl.textContent = `${fmtBytes(t.received)} / ${fmtBytes(t.total || asset.size)}`;
          const stageIdx = stageRow[t.stage === "" ? "download" : t.stage] ?? 0;
          stageIds.forEach((sid, i) => {
            const rowEl = stageRows.get(sid)!;
            rowEl.classList.toggle("cur", i === stageIdx);
            rowEl.classList.toggle("done", i < stageIdx);
            const m = rowEl.querySelector(".s-msg")!;
            if (sid === "download" && t.stage === "download") m.textContent = t.message;
            if (i < stageIdx) m.textContent = "完成";
          });
        } else if (!settledHandled) {
          settledHandled = true;
          if (t.state === "error") {
            stageRows.forEach((r) => r.classList.remove("cur"));
            msgEl.textContent = t.message;
            msgEl.style.color = "var(--danger)";
            const retry = h("button", { class: "btn", style: { marginTop: "18px" }, onClick: () => { goto("edition"); } }, ico("refresh"), "返回重试");
            page.append(retry);
            drawFootErr();
          } else if (t.state === "cancelled") {
            msgEl.textContent = "已取消";
          } else {
            goto("done");
            return;
          }
        }
      }
      setTimeout(tick, 250);
    };
    setTimeout(tick, 200);
  };

  const drawFootErr = () => {
    foot.innerHTML = "";
    foot.append(h("span", { class: "hint", style: { color: "var(--danger)" } }, "安装遇到问题，可返回重试或稍后在实例库中重试。"));
  };

  // ---- Step 4: 完成 ----
  const pageDone = (page: HTMLElement) => {
    page.append(
      h("div", { class: "o-title" }, "就绪。", h("span", { class: "serif" }, "Ready to launch")),
      h("div", { class: "o-sub" }, `实例「${finalName || instName}」安装完成。你可以在实例库中启动它、安装插件，或随时创建更多实例。`),
      h("div", { style: { marginTop: "36px" } },
        h("button", { class: "btn solid", onClick: () => void finish() }, ico("play"), "进入实例库"),
      ),
    );
  };

  const startInstall = async () => {
    if (!chosen) return;
    try {
      const inst = await api.createInstance(instName.trim(), chosen.edition, chosen);
      finalName = inst.name;
      installTaskId = `inst-${inst.id}`;
      goto("install");
    } catch (e) {
      toast("创建失败", String(e), "err");
    }
  };

  goto(step);
  return close;
}

/** 导入本地实例弹窗：选目录 → 探测 → 确认接管（原地，不移动文件）。返回导入后的实例。 */
export async function openImportModal(): Promise<InstanceMeta | null> {
  const start = state.settings?.instanceRoot ?? "D:\\";
  const picked = await sys.pickFolder("选择 EAC 实例目录（壳 exe 所在目录）", start);
  if (!picked) return null;
  const probe = await api.probeImport(picked);
  if (!probe.ok) {
    await confirmModal({
      title: "无法导入",
      body: `${picked}\n\n${probe.reason}`,
      confirmText: "知道了",
    });
    return null;
  }
  const ok = await confirmModal({
    title: "导入本地实例",
    body: `识别成功，将原地接管（不移动、不修改你的文件）：

目录    ${probe.dir}
类型    ${probe.edition === "lite" ? "Lite 轻量版" : "完整版"}
版本    ${probe.version || "未知"}
主程序  ${probe.exe}
数据目录  ${probe.dir}\dsh-home${probe.dshHomeExists ? "（已存在，沿用）" : "（将创建）"}`,
    confirmText: "导入",
  });
  if (!ok) return null;
  const name = await promptModal({ title: "实例名称", value: probe.suggestedName });
  if (name === null) return null;
  return await api.importInstance(picked, name || undefined);
}
