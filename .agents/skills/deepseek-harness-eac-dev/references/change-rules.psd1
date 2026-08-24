@{
    SchemaVersion = 1
    Rules = @(
        @{
            Name = 'tauri-rust'
            Domain = 'tauri-shell'
            Pattern = '^tauri-shell/src/.*\.rs$|^tauri-shell/Cargo\.(toml|lock)$'
            Reference = 'references/tauri-shell.md'
            Level = 'runtime'
            Tests = @('test/bridge-preload-parity.test.mjs')
            Smoke = @('cd tauri-shell; cargo run -- --bridge-test', 'node gui-smoke.js')
        },
        @{
            Name = 'sidecar-bridge'
            Domain = 'sidecar-bridge'
            Pattern = '^tauri-shell/sidecar/|bridge\.(ts|js)$|preload\.js$'
            Reference = 'references/sidecar-and-bridge.md'
            Level = 'runtime'
            Tests = @('test/bridge-preload-parity.test.mjs')
            Smoke = @('cd tauri-shell; cargo run -- --bridge-test')
        },
        @{
            Name = 'client-update'
            Domain = 'updates-packaging'
            Pattern = 'client-updater|lib/desktop/client-update|update-smoke'
            Reference = 'references/updates-and-packaging.md'
            Level = 'package'
            Tests = @(
                'test/client-update-platform.test.mjs',
                'test/client-updater-apply.test.mjs',
                'test/client-updater-asset.test.mjs',
                'test/client-updater-hash.test.mjs',
                'test/client-updater-node-arg.test.mjs',
                'test/client-updater-nospace.test.mjs',
                'test/client-updater-proxy.test.mjs',
                'test/client-updater-resume.test.mjs'
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
                'test/updater-backup.test.mjs',
                'test/updater-version.test.mjs',
                'test/update-mirror-chain.test.mjs'
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
                'test/bundle-integrity.test.mjs',
                'test/bundled-files.test.mjs',
                'test/verify-dist-fresh.test.mjs'
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
            Tests = @('test/bundled-files.test.mjs')
            Smoke = @()
        },
        @{
            Name = 'skins'
            Domain = 'plugins'
            Pattern = '^dsh-desktop/assets/skins/|dsh-skin-switch'
            Reference = 'references/dsh-plugins.md'
            Level = 'full'
            Tests = @(
                'test/skin-chrome-zindex.test.mjs',
                'test/skin-switch-css.test.mjs',
                'test/skin-switch-profile.test.mjs',
                'test/widget-theme.test.mjs'
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
            Tests = @('test/plugin-updater.test.mjs')
            Smoke = @()
        },
        @{
            Name = 'companion-sync'
            Domain = 'plugins'
            Pattern = 'companion-sync\.(ts|js)$'
            Reference = 'references/dsh-plugins.md'
            Level = 'full'
            Tests = @(
                'test/companion-copy-integrity.test.mjs',
                'test/companion-plugins-registry.test.mjs',
                'test/better-sidebar-bundle.test.mjs',
                'test/patch-row-heal.test.mjs',
                'test/retired-market-migration.test.mjs',
                'test/dsh-compact-integration.test.mjs'
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
                'test/plugin-manager-state.test.mjs',
                'test/plugin-manager-toggle.test.mjs',
                'test/onboarding-selection.test.mjs',
                'test/image-paste-core.test.mjs'
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
                'test/companion-plugins-registry.test.mjs',
                'test/companion-copy-integrity.test.mjs',
                'test/plugin-slot-registration.test.mjs',
                'test/onboarding-selection.test.mjs'
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
                'test/dsh-compact-engine.test.mjs',
                'test/dsh-compact-host.test.mjs',
                'test/dsh-compact-integration.test.mjs',
                'test/dsh-compact-migration.test.mjs',
                'test/dsh-compact-output-overflow.test.mjs',
                'test/dsh-compact-policy.test.mjs'
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
                'test/preset-sync.test.mjs',
                'test/patch-row-heal.test.mjs',
                'test/resolve-profile.test.mjs',
                'test/profile-module-heal.test.mjs'
            )
            Smoke = @('node boot-smoke.js')
        },
        @{
            Name = 'shortcuts'
            Domain = 'presets-profile'
            Pattern = 'shortcuts\.(ts|js)$|shortcut-maintenance'
            Reference = 'references/presets-and-profile.md'
            Level = 'full'
            Tests = @('test/shortcut-maintenance.test.mjs')
            Smoke = @()
        },
        @{
            Name = 'balance-pricing'
            Domain = 'product-services'
            Pattern = 'balance\.(ts|js)$|pricing-window|dsh-balance'
            Reference = 'references/product-services.md'
            Level = 'full'
            Tests = @(
                'test/balance-prices-core.test.mjs',
                'test/pricing-window.test.mjs',
                'test/widget-theme.test.mjs'
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
                'test/bundle-integrity.test.mjs',
                'test/bundled-files.test.mjs',
                'test/image-paste-core.test.mjs'
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
                'test/stable-port.test.mjs',
                'test/stream-write-after-end.test.mjs',
                'test/koffi-preflight.test.mjs',
                'test/error-detail.test.mjs',
                'test/builtin-collision.test.mjs',
                'test/bundle-integrity.test.mjs'
            )
            Smoke = @()
        },
        @{
            Name = 'wsl'
            Domain = 'product-services'
            Pattern = 'wsl-backend\.(ts|js)$'
            Reference = 'references/product-services.md'
            Level = 'runtime'
            Tests = @()
            Smoke = @('MANUAL: WSL environment acceptance')
        },
        @{
            Name = 'reliability'
            Domain = 'reliability-security'
            Pattern = 'guard|rescue|recovery|watchdog|logger|redact|safe-mode|diagnostics'
            Reference = 'references/reliability-and-security.md'
            Level = 'full'
            Tests = @(
                'test/boot-attribution.test.mjs',
                'test/diagnostics-zip.test.mjs',
                'test/logger-redact.test.mjs',
                'test/logger-rotate.test.mjs',
                'test/plugin-guard.test.mjs',
                'test/recovery-integration.test.mjs',
                'test/renderer-recovery.test.mjs',
                'test/rescue-agent.test.mjs',
                'test/rescue-auto-repair.test.mjs',
                'test/rescue-integration.test.mjs',
                'test/watchdog-behavior.test.mjs'
            )
            Smoke = @()
        },
        @{
            Name = 'packaging'
            Domain = 'updates-packaging'
            Pattern = 'stage-resources|make-portable|tauri\.conf\.json|installer|electron-builder|bundle-integrity|verify-dist'
            Reference = 'references/updates-and-packaging.md'
            Level = 'package'
            Tests = @(
                'test/bundle-integrity.test.mjs',
                'test/bundled-files.test.mjs',
                'test/installer-nsh-lengths.test.mjs',
                'test/installer-nsh-pipe.test.mjs',
                'test/installer-takeover.test.mjs',
                'test/verify-dist-fresh.test.mjs'
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
                'test/bridge-preload-parity.test.mjs',
                'test/bundled-files.test.mjs',
                'test/context-menu.test.mjs',
                'test/desktop-extras.test.mjs'
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
