@{
    SchemaVersion = 1
    Rules = @(
        @{
            Name = 'tauri-rust'
            Domain = 'tauri-shell'
            Pattern = '^tauri-shell/src/.*\.rs$|^tauri-shell/Cargo\.(toml|lock)$'
            Reference = 'references/tauri-shell.md'
            Level = 'runtime'
            Tests = @('test/bridge-preload-parity.test.ts')
            Smoke = @('cd tauri-shell; cargo run -- --bridge-test', 'node gui-smoke.js')
        },
        @{
            Name = 'sidecar-bridge'
            Domain = 'sidecar-bridge'
            Pattern = '^tauri-shell/sidecar/|bridge\.(ts|js)$|preload\.js$'
            Reference = 'references/sidecar-and-bridge.md'
            Level = 'runtime'
            Tests = @('test/bridge-preload-parity.test.ts')
            Smoke = @('cd tauri-shell; cargo run -- --bridge-test')
        },
        @{
            Name = 'client-update'
            Domain = 'updates-packaging'
            Pattern = 'client-updater|lib/desktop/client-update|update-smoke'
            Reference = 'references/updates-and-packaging.md'
            Level = 'package'
            Tests = @(
                'test/client-update-platform.test.ts',
                'test/client-updater-apply.test.ts',
                'test/client-updater-asset.test.ts',
                'test/client-updater-hash.test.ts',
                'test/client-updater-node-arg.test.ts',
                'test/client-updater-nospace.test.ts',
                'test/client-updater-proxy.test.ts',
                'test/client-updater-resume.test.ts'
            )
            Smoke = @('node update-smoke.js')
        },
        @{
            Name = 'agent-update'
            Domain = 'updates-packaging'
            Pattern = '(^|/)updater\.(js|ts)$'
            Reference = 'references/updates-and-packaging.md'
            Level = 'full'
            Tests = @(
                'test/updater-backup.test.ts',
                'test/updater-version.test.ts',
                'test/update-mirror-chain.test.ts'
            )
            Smoke = @()
        },
        @{
            Name = 'dependency-patches'
            Domain = 'dependency-patches'
            Pattern = '^dsh-desktop/scripts/patch-deps\.js$|^dsh-desktop/node_modules/@deepseek-ai/dsh-tool-(pwsh|fs|bash)/lib/index\.js$'
            Reference = 'references/dependency-patches.md'
            Level = 'package'
            Tests = @(
                'test/bundle-integrity.test.ts',
                'test/bundled-files.test.ts',
                'test/verify-dist-fresh.test.ts'
            )
            Smoke = @(
                'node tauri-shell/stage-resources.mjs',
                'MANUAL: verify patch-deps idempotence and the staged vendored overlay'
            )
        },
        @{
            Name = 'project-scripts'
            Domain = 'updates-packaging'
            Pattern = '^dsh-desktop/scripts/.*\.(js|cjs|mjs|ps1)$'
            Reference = 'references/updates-and-packaging.md'
            Level = 'full'
            Tests = @('test/bundled-files.test.ts')
            Smoke = @()
        },
        @{
            Name = 'skins'
            Domain = 'plugins'
            Pattern = '^dsh-desktop/assets/skins/|dsh-skin-switch'
            Reference = 'references/dsh-plugins.md'
            Level = 'full'
            Tests = @(
                'test/skin-chrome-zindex.test.ts',
                'test/skin-switch-css.test.ts',
                'test/skin-switch-profile.test.ts',
                'test/widget-theme.test.ts'
            )
            Smoke = @('node gui-smoke.js')
        },
        @{
            Name = 'bundled-skills'
            Domain = 'presets-profile'
            Pattern = '^dsh-desktop/assets/skills/|syncBundledSkills'
            Reference = 'references/presets-and-profile.md'
            Level = 'full'
            Tests = @()
            Smoke = @('node boot-smoke.js')
        },
        @{
            Name = 'openclaw-bridge'
            Domain = 'plugins'
            Pattern = '^openclaw-dsh-bridge/|dsh-openclaw-bridge'
            Reference = 'references/dsh-plugins.md'
            Level = 'full'
            Tests = @()
            Smoke = @('node --test openclaw-dsh-bridge/test/bridge.test.mjs')
        },
        @{
            Name = 'plugin-update'
            Domain = 'plugins'
            Pattern = 'plugin-updater\.(js|ts)$'
            Reference = 'references/dsh-plugins.md'
            Level = 'full'
            Tests = @('test/plugin-updater.test.ts')
            Smoke = @()
        },
        @{
            Name = 'companion-sync'
            Domain = 'plugins'
            Pattern = 'companion-sync\.(ts|js)$'
            Reference = 'references/dsh-plugins.md'
            Level = 'full'
            Tests = @(
                'test/companion-copy-integrity.test.ts',
                'test/companion-plugins-registry.test.ts',
                'test/better-sidebar-bundle.test.ts',
                'test/patch-row-heal.test.ts',
                'test/retired-market-migration.test.ts',
                'test/dsh-compact-integration.test.ts'
            )
            Smoke = @()
        },
        @{
            Name = 'plugin-ops'
            Domain = 'plugins'
            Pattern = 'plugin-ops\.(ts|js)$|plugin-manager-state|scripts/onboarding|scripts/plugin-manager-patch'
            Reference = 'references/dsh-plugins.md'
            Level = 'full'
            Tests = @(
                'test/plugin-manager-state.test.ts',
                'test/plugin-manager-toggle.test.ts',
                'test/onboarding-selection.test.ts',
                'test/image-paste-core.test.ts'
            )
            Smoke = @()
        },
        @{
            Name = 'plugin-package'
            Domain = 'plugins'
            Pattern = '^dsh-desktop/assets/plugins/'
            Reference = 'references/dsh-plugins.md'
            Level = 'full'
            Tests = @(
                'test/companion-plugins-registry.test.ts',
                'test/companion-copy-integrity.test.ts',
                'test/plugin-slot-registration.test.ts',
                'test/onboarding-selection.test.ts'
            )
            Smoke = @('node tauri-shell/stage-resources.mjs')
        },
        @{
            Name = 'dsh-compact'
            Domain = 'plugins'
            Pattern = 'dsh-compact|compact-preset-migrate'
            Reference = 'references/dsh-plugins.md'
            Level = 'full'
            Tests = @(
                'test/dsh-compact-engine.test.ts',
                'test/dsh-compact-host.test.ts',
                'test/dsh-compact-integration.test.ts',
                'test/dsh-compact-migration.test.ts',
                'test/dsh-compact-output-overflow.test.ts',
                'test/dsh-compact-policy.test.ts'
            )
            Smoke = @()
        },
        @{
            Name = 'presets-profile'
            Domain = 'presets-profile'
            Pattern = 'agent-presets|preset-sync|compact-preset-migrate|patch-row|profile|cordis\.patch'
            Reference = 'references/presets-and-profile.md'
            Level = 'full'
            Tests = @(
                'test/preset-sync.test.ts',
                'test/patch-row-heal.test.ts',
                'test/resolve-profile.test.ts',
                'test/profile-module-heal.test.ts'
            )
            Smoke = @('node boot-smoke.js')
        },
        @{
            Name = 'shortcuts'
            Domain = 'presets-profile'
            Pattern = 'shortcuts\.(ts|js)$|shortcut-maintenance'
            Reference = 'references/presets-and-profile.md'
            Level = 'full'
            Tests = @('test/shortcut-maintenance.test.ts')
            Smoke = @()
        },
        @{
            Name = 'balance-pricing'
            Domain = 'product-services'
            Pattern = 'balance\.(ts|js)$|pricing-window|dsh-balance'
            Reference = 'references/product-services.md'
            Level = 'full'
            Tests = @(
                'test/balance-prices-core.test.ts',
                'test/pricing-window.test.ts',
                'test/widget-theme.test.ts'
            )
            Smoke = @()
        },
        @{
            Name = 'session-notify'
            Domain = 'product-services'
            Pattern = 'session-watcher\.(ts|js)$|notifyOnTurnEnd'
            Reference = 'references/product-services.md'
            Level = 'runtime'
            Tests = @()
            Smoke = @('node gui-smoke.js')
        },
        @{
            Name = 'file-preview'
            Domain = 'product-services'
            Pattern = 'file-roots\.(ts|js)$|static-preview\.(ts|js)$|image-paste'
            Reference = 'references/product-services.md'
            Level = 'full'
            Tests = @(
                'test/bundle-integrity.test.ts',
                'test/bundled-files.test.ts',
                'test/image-paste-core.test.ts'
            )
            Smoke = @()
        },
        @{
            Name = 'runtime-utilities'
            Domain = 'product-services'
            Pattern = 'stable-port|stream-write-guard|koffi-preflight|error-detail|builtin-collision|bundle-integrity'
            Reference = 'references/product-services.md'
            Level = 'full'
            Tests = @(
                'test/stable-port.test.ts',
                'test/stream-write-after-end.test.ts',
                'test/koffi-preflight.test.ts',
                'test/error-detail.test.ts',
                'test/builtin-collision.test.ts',
                'test/bundle-integrity.test.ts'
            )
            Smoke = @()
        },
        @{
            Name = 'reliability'
            Domain = 'reliability-security'
            Pattern = 'guard|rescue|recovery|watchdog|logger|redact|safe-mode|diagnostics'
            Reference = 'references/reliability-and-security.md'
            Level = 'full'
            Tests = @(
                'test/boot-attribution.test.ts',
                'test/diagnostics-zip.test.ts',
                'test/logger-redact.test.ts',
                'test/logger-rotate.test.ts',
                'test/plugin-guard.test.ts',
                'test/recovery-integration.test.ts',
                'test/renderer-recovery.test.ts',
                'test/rescue-agent.test.ts',
                'test/rescue-auto-repair.test.ts',
                'test/rescue-integration.test.ts',
                'test/watchdog-behavior.test.ts'
            )
            Smoke = @()
        },
        @{
            Name = 'packaging'
            Domain = 'updates-packaging'
            Pattern = 'stage-resources|stage-platform-cache|audit-linux-bundle|make-portable|tauri(?:\.[^.]+)?\.conf\.json|^tauri-shell/gen/schemas/.*\.json$|installer|electron-builder|bundle-integrity|verify-dist'
            Reference = 'references/updates-and-packaging.md'
            Level = 'package'
            Tests = @(
                'test/bundle-integrity.test.ts',
                'test/bundled-files.test.ts',
                'test/installer-nsh-lengths.test.ts',
                'test/installer-nsh-pipe.test.ts',
                'test/installer-takeover.test.ts',
                'test/verify-dist-fresh.test.ts'
            )
            Smoke = @('node update-smoke.js', 'node upgrade-test-441.js')
        },
        @{
            Name = 'electron-fallback'
            Domain = 'sidecar-bridge'
            Pattern = '^dsh-desktop/main\.js$|^dsh-desktop/preload\.js$'
            Reference = 'references/sidecar-and-bridge.md'
            Level = 'runtime'
            Tests = @(
                'test/bridge-preload-parity.test.ts',
                'test/bundled-files.test.ts',
                'test/context-menu.test.ts',
                'test/desktop-extras.test.ts'
            )
            Smoke = @()
        },
        @{
            Name = 'general-project-code'
            Domain = 'product-services'
            Pattern = '^dsh-desktop/(lib/desktop/|[^/]+\.(ts|js)$)'
            Reference = 'references/product-services.md'
            Level = 'full'
            Tests = @()
            Smoke = @()
        },
        @{
            Name = 'test-files'
            Domain = 'tests-acceptance'
            Pattern = '(^|/)test/|smoke\.js$|upgrade-test'
            Reference = 'references/testing-and-acceptance.md'
            Level = 'targeted'
            Tests = @()
            Smoke = @()
        },
        @{
            Name = 'ci-workflow'
            Domain = 'release-git'
            Pattern = '^\.github/workflows/(?!release).*\.ya?ml$'
            Reference = 'references/release-and-git.md'
            Level = 'targeted'
            Tests = @()
            Smoke = @(
                'MANUAL: review workflow triggers, permissions, shells, paths and local command parity'
            )
        },
        @{
            Name = 'release'
            Domain = 'release-git'
            Pattern = '^\.github/workflows/release.*\.ya?ml$|(^|/)CHANGELOG|package-lock\.json$'
            Reference = 'references/release-and-git.md'
            Level = 'package'
            Tests = @()
            Smoke = @()
        },
        @{
            Name = 'git-policy'
            Domain = 'release-git'
            Pattern = '(^|/)\.gitignore$|(^|/)\.gitattributes$|CODEOWNERS|PULL_REQUEST_TEMPLATE|pull_request_template|CONTRIBUTING\.md$'
            Reference = 'references/team-git-workflow.md'
            Level = 'targeted'
            Tests = @()
            Smoke = @('git diff --check', 'MANUAL: review line-ending and repository policy impact')
        },
        @{
            Name = 'documentation'
            Domain = 'documentation'
            Pattern = '(^|/)(docs|research)/.*\.(md|txt)$|(^|/)(README|CHANGELOG|CONTRIBUTING).*\.md$'
            Reference = 'references/release-and-git.md'
            Level = 'targeted'
            Tests = @()
            Smoke = @()
            Documentation = $true
        },
        @{
            Name = 'skill-maintenance'
            Domain = 'skill-maintenance'
            Pattern = '(^|/)(\.agents/skills/deepseek-harness-eac-dev|deepseek-harness-eac-dev)/(SKILL\.md|agents/openai\.yaml|references/.*\.(md|psd1)|scripts/.*\.ps1|tests/.*\.ps1)$'
            Reference = 'references/skill-maintenance.md'
            Level = 'targeted'
            Tests = @()
            Smoke = @()
            SelfCheck = $true
            Exclusive = $true
        }
    )
}
