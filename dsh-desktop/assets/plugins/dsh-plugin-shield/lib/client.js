/**
 * dsh-plugin-shield — browser half: the 插件保护中心 settings section.
 *
 *   - 状态卡：当前 profile、快照份数、最后良好快照时间
 *   - 快照：立即快照 / 列表（时间 · 原因 · 插件行数）/ 一键回滚
 *   - 健康检查：静态体检（模块遮蔽 / patch 行 / junction 归属 / 高危扫描）
 *     + 一键修复（只动插件与配置层，绝不碰内核与用户数据）
 *   - 事故报告：守护启动自动回滚/修复的记录，可查看与标记解决
 *
 * All actions ride the window.dshDesktop.guard IPC bridge (desktop shell's
 * plugin-guard.js engine). Outside the desktop shell the section renders a
 * short note instead of half-broken controls.
 *
 * Hand-written ModuleLoader bundle — no build step required.
 */
window.__ModuleLoader__.load({
  id: "dsh-plugin-shield",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    var react = require("react");
    var h = react.createElement;

    var CSS = ".__sh_root{max-width:640px;display:flex;flex-direction:column;gap:12px}" +
      ".__sh_hint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);margin:0}" +
      ".__sh_cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px}" +
      ".__sh_card{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:8px 10px;background:var(--dsw-alias-bg-layer-3)}" +
      ".__sh_cardk{font-size:11px;color:var(--dsw-alias-label-tertiary)}" +
      ".__sh_cardv{font-size:14px;font-weight:600;margin-top:2px;word-break:break-all}" +
      ".__sh_btn{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);border-radius:8px;padding:6px 14px;font:inherit;font-size:13px;cursor:pointer}" +
      ".__sh_btn:hover:not(:disabled){border-color:var(--dsw-alias-state-business-primary)}" +
      ".__sh_btn:disabled{opacity:.5;cursor:default}" +
      ".__sh_btnPrimary{border-color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-on-accent)}" +
      ".__sh_btnDanger{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}" +
      ".__sh_actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}" +
      ".__sh_list{display:flex;flex-direction:column;gap:6px;max-height:320px;overflow:auto}" +
      ".__sh_row{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:8px 10px;background:var(--dsw-alias-bg-layer-3);display:flex;gap:10px;align-items:center}" +
      ".__sh_rowmain{flex:1;min-width:0}" +
      ".__sh_rowtitle{font-size:13px;font-weight:600}" +
      ".__sh_rowsub{font-size:11px;color:var(--dsw-alias-label-tertiary);margin-top:1px;word-break:break-all}" +
      ".__sh_ok{font-size:12px;color:var(--dsw-alias-state-success-primary)}" +
      ".__sh_err{font-size:12px;color:var(--dsw-alias-state-error-primary)}" +
      ".__sh_warn{font-size:12px;color:#e6a23c}" +
      ".__sh_finding{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:8px 10px;background:var(--dsw-alias-bg-layer-3);font-size:12px;line-height:18px}" +
      ".__sh_fcode{font-family:var(--dsw-alias-font-mono,monospace);font-size:11px;color:var(--dsw-alias-label-tertiary)}" +
      ".__sh_pre{white-space:pre-wrap;font-family:var(--dsw-alias-font-mono,monospace);font-size:11px;line-height:1.5;max-height:260px;overflow:auto;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:8px 10px;background:var(--dsw-alias-bg-layer-2)}" +
      ".__sh_h3{font-size:13px;font-weight:600;margin:0}";
    var tagId = "dsh-plugin-shield/main.css";
    if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
      var tag = document.createElement("style");
      tag.dataset.plugin = "dsh-plugin-shield";
      tag.dataset.pluginCss = tagId;
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    var NS = "pluginShield";
    var zh = {
      nav: "插件保护",
      intro: "桌面端内置的插件安全网（融合 dsh-plugin-guard / dsh-web-plugin-manager / dsh-plugin-healthcheck 并内置）：每次安装与启动前自动快照，启动失败自动体检修复、必要时回滚到最后良好快照，全程留事故报告。此页面用于手动快照、回滚与体检。",
      needDesktop: "插件保护中心需要 Deepseek Harness EAC 桌面端运行（此页面在浏览器/CLI 模式下只读展示）。",
      statProfile: "受保护 profile",
      statSnapshots: "快照份数",
      statLastGood: "最后良好快照",
      statIncidents: "待处理事故",
      none: "（无）",
      snapshotNow: "立即快照",
      check: "运行健康检查",
      repair: "一键修复",
      refresh: "刷新",
      snapshotsTitle: "快照",
      snapshotDone: "已创建快照",
      restore: "回滚到此快照",
      restoreConfirm: "回滚将把 profile 的插件配置（package.json / 锁文件 / cordis.patch.yml）恢复到该快照时刻，之后重启 Web 服务生效。确定继续？",
      restoreRunning: "服务正在运行，请先重启 Web 服务（或关掉重开客户端）再回滚。",
      restored: "已回滚，重启 Web 服务后生效",
      findingsTitle: "体检发现",
      findingsClean: "一切正常：模块遮蔽 / patch 行 / junction 归属 / 高危静态扫描均无发现。",
      fixable: "可修复",
      manual: "需人工处理",
      repaired: "已应用修复",
      repairedNone: "没有可自动修复的项",
      incidentsTitle: "事故报告",
      incidentsEmpty: "（暂无事故报告 —— 守护启动一切正常）",
      view: "查看",
      resolve: "标记解决",
      close: "关闭",
      busy: "处理中…",
      reason: "原因",
      pluginRows: "插件行",
      files: "文件",
      compatTitle: "版本兼容防线",
      compatIntro: "启动前与体检时静态核对每个插件与内核的对应关系：插件包/入口缺失（loader 必崩，9/3 连环启动失败根因）、peer 依赖不满足、客户端注入缺失、dsh.kernel 版本窗口违例。可自动处置的项在启动前已自动隔离（快照 + patch disabled + 事故记录），此处可查看明细或手动隔离。",
      compatKernel: "内核版本",
      compatEntries: "插件条目",
      compatIssues: "存在问题",
      compatHealthy: "全部对应正常",
      compatNone: "（无可隔离项）",
      compatInstalled: "未安装",
      compatEntryMissing: "包/入口缺失",
      compatPeerBad: "依赖不满足",
      compatPeerDrift: "依赖漂移",
      compatInjectBad: "注入缺失",
      compatKernelBad: "版本窗口违例",
      compatQuarantine: "隔离此插件",
      quarantineConfirm: "隔离将立即把该插件在 cordis.patch.yml 中标记为 disabled（先自动创建快照，可随时回滚），重启 Web 服务后生效。确定继续？",
      quarantined: "已隔离，重启 Web 服务后生效"
    };
    var en = {
      nav: "Plugin Guard",
      intro: "Built-in plugin safety net (fuses dsh-plugin-guard / dsh-web-plugin-manager / dsh-plugin-healthcheck): snapshots before every install and boot, auto-repairs and rolls back failed boots, and files incident reports. Use this page for manual snapshots, rollback and health checks.",
      needDesktop: "The guard center needs the Deepseek Harness EAC desktop shell (read-only outside it).",
      statProfile: "protected profile",
      statSnapshots: "snapshots",
      statLastGood: "last good boot",
      statIncidents: "open incidents",
      none: "(none)",
      snapshotNow: "Snapshot now",
      check: "Run health check",
      repair: "Repair",
      refresh: "Refresh",
      snapshotsTitle: "Snapshots",
      snapshotDone: "Snapshot created",
      restore: "Roll back here",
      restoreConfirm: "Rollback restores the profile's plugin configuration (package.json / lockfile / cordis.patch.yml) to this snapshot, then restart the web service. Continue?",
      restoreRunning: "The web service is running — restart it (or reopen the app) before rolling back.",
      restored: "Rolled back — restart the web service to apply",
      findingsTitle: "Findings",
      findingsClean: "All clear: module shadowing / patch rows / junction ownership / static threat scan found nothing.",
      fixable: "fixable",
      manual: "manual",
      repaired: "Repairs applied",
      repairedNone: "Nothing auto-repairable",
      incidentsTitle: "Incidents",
      incidentsEmpty: "(no incidents — guarded boots are all healthy)",
      view: "View",
      resolve: "Resolve",
      close: "Close",
      busy: "Working…",
      reason: "reason",
      pluginRows: "plugin rows",
      files: "files",
      compatTitle: "Version Compatibility Line",
      compatIntro: "Static checks on boot and in health checks: plugin package/entry missing (fatal for the loader — the root cause of the Sep 3 boot-failure chain), unsatisfied peer dependencies, missing client injects, and dsh.kernel window violations. Auto-quarantinable findings are isolated before boot (snapshot + patch disabled + incident); inspect details or quarantine manually here.",
      compatKernel: "kernel version",
      compatEntries: "plugin entries",
      compatIssues: "issues",
      compatHealthy: "all entries compatible",
      compatNone: "(nothing to quarantine)",
      compatInstalled: "not installed",
      compatEntryMissing: "package/entry missing",
      compatPeerBad: "dependency unsatisfied",
      compatPeerDrift: "dependency drift",
      compatInjectBad: "inject missing",
      compatKernelBad: "kernel window violated",
      compatQuarantine: "Quarantine",
      quarantineConfirm: "Quarantining immediately marks this plugin as disabled in cordis.patch.yml (a snapshot is taken first; you can roll back anytime). Restart the web service to apply. Continue?",
      quarantined: "Quarantined — restart the web service to apply"
    };

    var inject = ["slots", "locale"];

    function fmtTime(iso) {
      try {
        var d = new Date(iso);
        return d.toLocaleString(undefined, { hour12: false });
      } catch (e) {
        return String(iso || "");
      }
    }

    function ShieldSection(props) {
      var t = props.t;
      var bridge = (typeof window !== "undefined" && window.dshDesktop && window.dshDesktop.guard) || null;

      var state = react.useState({ status: "loading" });
      var data = state[0];
      var setData = state[1];
      var busyState = react.useState(null);
      var busy = busyState[0];
      var setBusy = busyState[1];
      var reportState = react.useState(null);
      var report = reportState[0];
      var setReport = reportState[1];
      var incidentState = react.useState(null);
      var incident = incidentState[0];
      var setIncident = incidentState[1];
      var versionState = react.useState(null);
      var version = versionState[0];
      var setVersion = versionState[1];

      var call = function (action, value) {
        if (!bridge) return Promise.resolve({ ok: false, error: "no-bridge" });
        return bridge.action(action, value);
      };

      var loadVersion = react.useCallback(function () {
        if (!bridge) return;
        call("version").then(function (r) {
          if (r && r.ok) setVersion(r.report || null);
        }).catch(function () { /* 版本报告失败不打扰 */ });
      }, [bridge]);

      var load = react.useCallback(function () {
        if (!bridge) { setData({ status: "no-bridge" }); return; }
        setData({ status: "loading" });
        call("status").then(function (r) {
          if (r && r.ok) setData({ status: "ready", profile: r.profile, snapshots: r.snapshots || [], incidents: r.incidents || [], lastGood: r.lastGood || null });
          else setData({ status: "error", error: (r && r.error) || "failed" });
        }).catch(function (e) { setData({ status: "error", error: String(e) }); });
      }, [bridge]);
      react.useEffect(load, [load]);
      react.useEffect(loadVersion, [loadVersion]);

      if (data.status === "loading") return h("div", { className: "__sh_root" }, h("p", { className: "__sh_hint" }, "…"));
      if (data.status === "no-bridge") {
        return h("div", { className: "__sh_root" },
          h("p", { className: "__sh_hint" }, t("needDesktop")));
      }
      if (data.status === "error") {
        return h("div", { className: "__sh_root" }, h("p", { className: "__sh_err" }, String(data.error)));
      }

      var doSnapshot = function () {
        setBusy("snapshot");
        call("snapshot", "manual").then(function () { setBusy(null); load(); }).catch(function () { setBusy(null); });
      };
      var doCheck = function () {
        setBusy("check");
        setReport(null);
        call("check").then(function (r) {
          setBusy(null);
          if (r && r.ok) setReport(r.report || { findings: [] });
        }).catch(function () { setBusy(null); });
      };
      var doRepair = function () {
        setBusy("repair");
        call("repair").then(function (r) {
          setBusy(null);
          setReport({ repaired: (r && r.applied) || [], at: new Date().toISOString() });
        }).catch(function () { setBusy(null); });
      };
      var doRestore = function (id) {
        if (!window.confirm(t("restoreConfirm"))) return;
        setBusy("restore:" + id);
        call("restore", id).then(function (r) {
          setBusy(null);
          if (r && r.ok) window.alert(t("restored"));
          else if (r && r.error === "service-running") window.alert(t("restoreRunning"));
          else window.alert(String((r && r.error) || "failed"));
        }).catch(function () { setBusy(null); });
      };
      var openIncident = function (id) {
        setBusy("incident:" + id);
        call("incident", id).then(function (r) {
          setBusy(null);
          if (r && r.ok) setIncident({ id: id, content: r.content });
        }).catch(function () { setBusy(null); });
      };
      var resolveIncident = function (id) {
        setBusy("resolve:" + id);
        call("resolve-incident", id).then(function () { setBusy(null); setIncident(null); load(); }).catch(function () { setBusy(null); });
      };
      var doQuarantine = function (id) {
        if (!window.confirm(t("quarantineConfirm"))) return;
        setBusy("q:" + id);
        call("quarantine", id).then(function (r) {
          setBusy(null);
          if (r && r.ok) { window.alert(t("quarantined")); loadVersion(); load(); }
          else window.alert(String((r && r.error) || "failed"));
        }).catch(function () { setBusy(null); });
      };

      var findings = report && report.findings ? report.findings : null;
      var repairedList = report && report.repaired ? report.repaired : null;

      var compatEntries = version && version.entries ? version.entries : null;
      var compatIssues = function (e) {
        var out = [];
        if (!e.installed) out.push(t("compatInstalled"));
        if (e.installed && !e.entryPoint) out.push(t("compatEntryMissing"));
        if (!e.enabled) return out;
        (e.peers || []).forEach(function (p) {
          if (p.optional) return; // 可选 peer 不算问题
          if (p.verdict === "missing" || p.verdict === "high") out.push(p.dep + " → " + t("compatPeerBad"));
          else if (p.verdict === "low") out.push(p.dep + " → " + t("compatPeerDrift"));
        });
        (e.inject || []).forEach(function (i2) { if (i2.ok !== true) out.push(i2.dep + " → " + t("compatInjectBad")); });
        (e.issues || []).forEach(function (i3) { out.push(t("compatKernelBad") + "：" + i3); });
        return out;
      };
      var compatQuarantinable = function (e) {
        if (!e.enabled || !e.id) return false;
        if (!e.installed || (e.installed && !e.entryPoint)) return true;
        return (e.peers || []).some(function (p) { return p.verdict === "missing" || p.verdict === "high"; });
      };

      return h("div", { className: "__sh_root" },
        h("p", { className: "__sh_hint", style: { margin: 0 } }, t("intro")),
        h("div", { className: "__sh_cards" },
          h("div", { className: "__sh_card" }, h("div", { className: "__sh_cardk" }, t("statProfile")), h("div", { className: "__sh_cardv" }, data.profile || "—")),
          h("div", { className: "__sh_card" }, h("div", { className: "__sh_cardk" }, t("statSnapshots")), h("div", { className: "__sh_cardv" }, String(data.snapshots.length))),
          h("div", { className: "__sh_card" }, h("div", { className: "__sh_cardk" }, t("statLastGood")), h("div", { className: "__sh_cardv" }, data.lastGood ? fmtTime(data.lastGood.at) : t("none"))),
          h("div", { className: "__sh_card" }, h("div", { className: "__sh_cardk" }, t("statIncidents")), h("div", { className: "__sh_cardv" }, String(data.incidents.length)))
        ),
        h("div", { className: "__sh_actions" },
          h("button", { className: "__sh_btn __sh_btnPrimary", disabled: !!busy, onClick: doSnapshot }, busy === "snapshot" ? t("busy") : t("snapshotNow")),
          h("button", { className: "__sh_btn", disabled: !!busy, onClick: doCheck }, busy === "check" ? t("busy") : t("check")),
          h("button", { className: "__sh_btn", disabled: !!busy, onClick: doRepair }, busy === "repair" ? t("busy") : t("repair")),
          h("button", { className: "__sh_btn", disabled: !!busy, onClick: load }, t("refresh"))
        ),

        findings ? h("div", null,
          h("h3", { className: "__sh_h3" }, t("findingsTitle")),
          findings.length === 0 ? h("p", { className: "__sh_ok" }, t("findingsClean")) :
            findings.map(function (f, i) {
              return h("div", { className: "__sh_finding", key: String(i) },
                h("span", { className: f.severity === "high" ? "__sh_err" : "__sh_warn" },
                  "[" + f.severity + "] " + (f.fixable ? t("fixable") : t("manual")) + " · "),
                h("span", { className: "__sh_fcode" }, f.code),
                h("div", null, f.message)
              );
            })
        ) : null,
        repairedList ? h("div", null,
          repairedList.length ? h("p", { className: "__sh_ok" }, t("repaired") + "：") : h("p", { className: "__sh_ok" }, t("repairedNone")),
          repairedList.length ? h("ul", { className: "__sh_hint" }, repairedList.map(function (a, i) { return h("li", { key: String(i) }, a); })) : null
        ) : null,

        compatEntries ? h("div", null,
          h("h3", { className: "__sh_h3" }, t("compatTitle")),
          h("p", { className: "__sh_hint" }, t("compatIntro")),
          version && version.kernel ? h("div", { className: "__sh_cards" },
            h("div", { className: "__sh_card" }, h("div", { className: "__sh_cardk" }, t("compatKernel")), h("div", { className: "__sh_cardv" }, String(version.kernel.version || "—"))),
            h("div", { className: "__sh_card" }, h("div", { className: "__sh_cardk" }, t("compatEntries")), h("div", { className: "__sh_cardv" }, String(compatEntries.length))),
            h("div", { className: "__sh_card" },
              h("div", { className: "__sh_cardk" }, t("compatIssues")),
              h("div", { className: "__sh_cardv", style: { color: compatEntries.some(compatIssues) ? "var(--dsw-alias-state-error-primary)" : undefined } },
                String(compatEntries.filter(compatIssues).length))
            )
          ) : null,
          compatEntries.filter(compatIssues).length === 0 ? h("p", { className: "__sh_ok" }, t("compatHealthy")) :
            h("div", { className: "__sh_list", style: { maxHeight: 360 } }, compatEntries.map(function (e, i) {
              var issues = compatIssues(e);
              if (!issues.length) return null;
              return h("div", { className: "__sh_row", key: String(i) },
                h("div", { className: "__sh_rowmain" },
                  h("div", { className: "__sh_rowtitle" }, String(e.name || e.id) + (e.version ? " v" + e.version : "") + (e.enabled ? "" : "（disabled）")),
                  h("div", { className: "__sh_rowsub" }, issues.map(function (m, k) {
                    return h("div", { key: String(k), className: k < 2 ? "__sh_err" : "__sh_warn" }, "· " + m);
                  }))
                ),
                compatQuarantinable(e) ? h("button", {
                  className: "__sh_btn __sh_btnDanger",
                  disabled: !!busy,
                  onClick: function () { doQuarantine(e.id); }
                }, busy === "q:" + e.id ? t("busy") : t("compatQuarantine")) : null
              );
            }))
        ) : null,

        h("div", null,
          h("h3", { className: "__sh_h3" }, t("snapshotsTitle")),
          data.snapshots.length === 0 ? h("p", { className: "__sh_hint" }, t("none")) :
            h("div", { className: "__sh_list" }, data.snapshots.map(function (s) {
              return h("div", { className: "__sh_row", key: s.id },
                h("div", { className: "__sh_rowmain" },
                  h("div", { className: "__sh_rowtitle" }, fmtTime(s.at)),
                  h("div", { className: "__sh_rowsub" }, t("reason") + "：" + (s.reason || "manual") + " · " + t("pluginRows") + " " + String((s.pluginRows || []).length) + " · " + t("files") + " " + String((s.files || []).length))
                ),
                h("button", {
                  className: "__sh_btn __sh_btnDanger",
                  disabled: !!busy,
                  onClick: function () { doRestore(s.id); }
                }, busy === "restore:" + s.id ? t("busy") : t("restore"))
              );
            }))
        ),

        h("div", null,
          h("h3", { className: "__sh_h3" }, t("incidentsTitle")),
          data.incidents.length === 0 ? h("p", { className: "__sh_hint" }, t("incidentsEmpty")) :
            h("div", { className: "__sh_list" }, data.incidents.map(function (it) {
              return h("div", { className: "__sh_row", key: it.id },
                h("div", { className: "__sh_rowmain" },
                  h("div", { className: "__sh_rowtitle" }, it.title),
                  incident && incident.id === it.id
                    ? h("div", { style: { marginTop: 6 } },
                        h("pre", { className: "__sh_pre" }, incident.content),
                        h("div", { className: "__sh_actions", style: { marginTop: 6 } },
                          h("button", { className: "__sh_btn", onClick: function () { setIncident(null); } }, t("close")),
                          h("button", { className: "__sh_btn", disabled: !!busy, onClick: function () { resolveIncident(it.id); } }, busy === "resolve:" + it.id ? t("busy") : t("resolve"))
                        )
                      )
                    : null
                ),
                incident && incident.id === it.id ? null : h("button", {
                  className: "__sh_btn",
                  disabled: !!busy,
                  onClick: function () { openIncident(it.id); }
                }, busy === "incident:" + it.id ? t("busy") : t("view"))
              );
            }))
        )
      );
    }

    function apply(ctx) {
      var t = ctx.locale.bind(NS);
      ctx.effect(function () { return ctx.locale.register(NS, { zh: zh, en: en }); }, "dsh-plugin-shield: dictionaries");
      ctx.slots.inject("settings.section", function () {
        return ctx.slots.register({
          name: "settings.section",
          id: "plugin-shield",
          order: 23,
          label: function () { return t("nav"); },
          locale: NS
        }, function (props) {
          return h(ShieldSection, props);
        });
      });
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
