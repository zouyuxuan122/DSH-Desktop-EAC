// GENERATED FILE — do not edit by hand.
// Source: .sync/plugins.json (run generate-plugin-registry.mjs).
// plugin-sync:update-sources {"better-sidebar":{"npm":"dsh-better-sidebar"},"computer-user":{"npm":"computer-user"},"dsh-navbar":{"npm":"@vlln/dsh-navbar"},"dsh-pet":{"npm":"dsh-pet"},"dsh-session-manager":{"npm":"dsh-session-manager"},"dsh-undo":{"github":"lire1131/dsh-undo-savepoint"},"mobile-fix":{"npm":"dsh-web-mobile-fix"},"offpeak":{"npm":"dsh-offpeak"},"picturereader":{"npm":"picturereader"},"soul-md":{"npm":"dsh-soul-md"},"think-zh-expand-eac":{"github":"jing-hy/dsh-think-zh-expand-eac"},"unified-market":{"npm":"dsh-unified-market"}}

export const PLUGIN_SYNC_REGISTRY = {
  "entries": {
    "agent-teams": {
      "class": "patched",
      "kind": "plugin",
      "packageName": "@nanmicoder/dsh-agent-teams",
      "path": "dsh-desktop/assets/plugins/dsh-agent-teams",
      "runtimeUpdate": {
        "allowed": false,
        "defaultAction": "prompt"
      },
      "source": {
        "kind": "github",
        "repository": "git+https://github.com/NanmiCoder/dsh-agent-teams.git"
      },
      "syncMode": "patch-rebase"
    },
    "balance": {
      "class": "internal",
      "kind": "plugin",
      "packageName": "@deepseek-ai/dsh-balance",
      "path": "dsh-desktop/assets/plugins/dsh-balance",
      "runtimeUpdate": {
        "allowed": false,
        "defaultAction": "prompt"
      },
      "source": {
        "kind": "internal",
        "name": "@deepseek-ai/dsh-balance",
        "reason": "maintained in this repository; no external source is declared"
      },
      "syncMode": "manual"
    },
    "better-sidebar": {
      "class": "patched",
      "kind": "plugin",
      "packageName": "dsh-better-sidebar",
      "path": "dsh-desktop/assets/plugins/dsh-better-sidebar",
      "runtimeUpdate": {
        "allowed": true,
        "defaultAction": "prompt",
        "source": {
          "kind": "npm",
          "name": "dsh-better-sidebar"
        }
      },
      "source": {
        "kind": "npm",
        "name": "dsh-better-sidebar",
        "repository": "https://github.com/omdsh-dev/DSH-better-sidebar"
      },
      "syncMode": "patch-rebase"
    },
    "change-review": {
      "class": "manual",
      "kind": "plugin",
      "packageName": "dsh-change-review",
      "path": "dsh-desktop/assets/plugins/dsh-change-review",
      "runtimeUpdate": {
        "allowed": false,
        "defaultAction": "prompt"
      },
      "source": {
        "kind": "unknown",
        "reason": "package.json does not declare a source repository; do not infer one from the directory name"
      },
      "syncMode": "manual"
    },
    "client-file-changes": {
      "class": "internal",
      "kind": "plugin",
      "packageName": "@deepseek-ai/dsh-client-file-changes",
      "path": "dsh-desktop/assets/plugins/dsh-client-file-changes",
      "runtimeUpdate": {
        "allowed": false,
        "defaultAction": "prompt"
      },
      "source": {
        "kind": "internal",
        "name": "@deepseek-ai/dsh-client-file-changes",
        "reason": "maintained in this repository; no external source is declared"
      },
      "syncMode": "manual"
    },
    "compact": {
      "class": "manual",
      "kind": "plugin",
      "packageName": "dsh-compact",
      "path": "dsh-desktop/assets/plugins/dsh-compact",
      "runtimeUpdate": {
        "allowed": false,
        "defaultAction": "prompt"
      },
      "source": {
        "kind": "unknown",
        "reason": "package.json does not declare a source repository; do not infer one from the directory name"
      },
      "syncMode": "manual"
    },
    "composer-dynamic-island": {
      "class": "follow-upstream",
      "kind": "plugin",
      "packageName": "dsh-composer-dynamic-island",
      "path": "dsh-desktop/assets/plugins/dsh-composer-dynamic-island",
      "runtimeUpdate": {
        "allowed": false,
        "defaultAction": "prompt"
      },
      "source": {
        "kind": "github",
        "repository": "git+https://github.com/says693/dsh-composer-dynamic-island.git"
      },
      "syncMode": "mirror"
    },
    "computer-user": {
      "class": "follow-upstream",
      "kind": "plugin",
      "packageName": "computer-user",
      "path": "dsh-desktop/assets/plugins/computer-user",
      "runtimeUpdate": {
        "allowed": true,
        "defaultAction": "prompt",
        "source": {
          "kind": "npm",
          "name": "computer-user"
        }
      },
      "source": {
        "kind": "npm",
        "name": "computer-user",
        "repository": "git+https://github.com/jing-hy/computer-user.git"
      },
      "syncMode": "mirror"
    },
    "conversation-tweaks": {
      "class": "internal",
      "kind": "plugin",
      "packageName": "@deepseek-ai/dsh-conversation-tweaks",
      "path": "dsh-desktop/assets/plugins/dsh-conversation-tweaks",
      "runtimeUpdate": {
        "allowed": false,
        "defaultAction": "prompt"
      },
      "source": {
        "kind": "internal",
        "name": "@deepseek-ai/dsh-conversation-tweaks",
        "reason": "maintained in this repository; no external source is declared"
      },
      "syncMode": "manual"
    },
    "dock-settings": {
      "class": "manual",
      "kind": "plugin",
      "packageName": "dsh-dock-settings",
      "path": "dsh-desktop/assets/plugins/dsh-dock-settings",
      "runtimeUpdate": {
        "allowed": false,
        "defaultAction": "prompt"
      },
      "source": {
        "kind": "unknown",
        "reason": "package.json does not declare a source repository; do not infer one from the directory name"
      },
      "syncMode": "manual"
    },
    "dsh-dafeiyu": {
      "class": "resource",
      "kind": "plugin",
      "packageName": "dsh-dafeiyu",
      "path": "dsh-desktop/assets/plugins/dsh-dafeiyu",
      "runtimeUpdate": {
        "allowed": false,
        "defaultAction": "prompt"
      },
      "source": {
        "kind": "github",
        "repository": "git+https://github.com/QCYTSN/dsh-dafeiyu.git"
      },
      "syncMode": "metadata-only"
    },
    "dsh-feature-toggles": {
      "class": "manual",
      "kind": "plugin",
      "packageName": "dsh-feature-toggles",
      "path": "dsh-desktop/assets/plugins/dsh-feature-toggles",
      "runtimeUpdate": {
        "allowed": false,
        "defaultAction": "prompt"
      },
      "source": {
        "kind": "unknown",
        "reason": "package.json does not declare a source repository; do not infer one from the directory name"
      },
      "syncMode": "manual"
    },
    "dsh-navbar": {
      "class": "follow-upstream",
      "kind": "plugin",
      "packageName": "@vlln/dsh-navbar",
      "path": "dsh-desktop/assets/plugins/dsh-navbar",
      "runtimeUpdate": {
        "allowed": true,
        "defaultAction": "prompt",
        "source": {
          "kind": "npm",
          "name": "@vlln/dsh-navbar"
        }
      },
      "source": {
        "kind": "npm",
        "name": "@vlln/dsh-navbar"
      },
      "syncMode": "mirror"
    },
    "dsh-pet": {
      "class": "follow-upstream",
      "kind": "plugin",
      "packageName": "dsh-pet",
      "path": "dsh-desktop/assets/plugins/dsh-pet",
      "runtimeUpdate": {
        "allowed": true,
        "defaultAction": "prompt",
        "source": {
          "kind": "npm",
          "name": "dsh-pet"
        }
      },
      "source": {
        "kind": "npm",
        "name": "dsh-pet",
        "repository": "git+https://github.com/PC2005-cloud/dsh-pet.git"
      },
      "syncMode": "mirror"
    },
    "dsh-pet-settings": {
      "class": "manual",
      "kind": "plugin",
      "packageName": "dsh-pet-settings",
      "path": "dsh-desktop/assets/plugins/dsh-pet-settings",
      "runtimeUpdate": {
        "allowed": false,
        "defaultAction": "prompt"
      },
      "source": {
        "kind": "unknown",
        "reason": "package.json does not declare a source repository; do not infer one from the directory name"
      },
      "syncMode": "manual"
    },
    "dsh-phone": {
      "class": "internal",
      "kind": "plugin",
      "packageName": "dsh-phone",
      "path": "dsh-desktop/assets/plugins/dsh-phone",
      "runtimeUpdate": {
        "allowed": false,
        "defaultAction": "prompt"
      },
      "source": {
        "kind": "internal",
        "name": "dsh-phone",
        "reason": "maintained in this repository; no external source is declared"
      },
      "syncMode": "manual"
    },
    "dsh-raw-html": {
      "class": "manual",
      "kind": "plugin",
      "packageName": "dsh-raw-html",
      "path": "dsh-desktop/assets/plugins/dsh-raw-html",
      "runtimeUpdate": {
        "allowed": false,
        "defaultAction": "prompt"
      },
      "source": {
        "kind": "internal",
        "name": "dsh-raw-html",
        "reason": "maintained in this repository; no external source is declared"
      },
      "syncMode": "manual"
    },
    "dsh-session-manager": {
      "class": "follow-upstream",
      "kind": "plugin",
      "packageName": "dsh-session-manager",
      "path": "dsh-desktop/assets/plugins/dsh-session-manager",
      "runtimeUpdate": {
        "allowed": true,
        "defaultAction": "prompt",
        "source": {
          "kind": "npm",
          "name": "dsh-session-manager"
        }
      },
      "source": {
        "kind": "npm",
        "name": "dsh-session-manager"
      },
      "syncMode": "mirror"
    },
    "dsh-undo": {
      "class": "follow-upstream",
      "kind": "plugin",
      "packageName": "dsh-undo-savepoint",
      "path": "dsh-desktop/assets/plugins/dsh-undo-savepoint",
      "runtimeUpdate": {
        "allowed": true,
        "defaultAction": "prompt",
        "source": {
          "kind": "github",
          "repository": "https://github.com/lire1131/dsh-undo-savepoint"
        }
      },
      "source": {
        "kind": "github",
        "repository": "https://github.com/lire1131/dsh-undo-savepoint"
      },
      "syncMode": "mirror"
    },
    "dsh-webui-prompt-optimizer": {
      "class": "manual",
      "kind": "plugin",
      "packageName": "dsh-webui-prompt-optimizer",
      "path": "dsh-desktop/assets/plugins/dsh-webui-prompt-optimizer",
      "runtimeUpdate": {
        "allowed": false,
        "defaultAction": "prompt"
      },
      "source": {
        "kind": "unknown",
        "reason": "package.json does not declare a source repository; do not infer one from the directory name"
      },
      "syncMode": "manual"
    },
    "dsh-whale-widget": {
      "class": "resource",
      "kind": "plugin",
      "packageName": "dsh-whale-widget",
      "path": "dsh-desktop/assets/plugins/dsh-whale-widget",
      "runtimeUpdate": {
        "allowed": false,
        "defaultAction": "prompt"
      },
      "source": {
        "kind": "github",
        "repository": "git+https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget.git"
      },
      "syncMode": "metadata-only"
    },
    "eac-core-bridge": {
      "class": "manual",
      "kind": "plugin",
      "packageName": "dsh-eac-core-bridge",
      "path": "dsh-desktop/assets/plugins/dsh-eac-core-bridge",
      "runtimeUpdate": {
        "allowed": false,
        "defaultAction": "prompt"
      },
      "source": {
        "kind": "unknown",
        "reason": "package.json does not declare a source repository; do not infer one from the directory name"
      },
      "syncMode": "manual"
    },
    "eac-locale-compat": {
      "class": "manual",
      "kind": "plugin",
      "packageName": "dsh-eac-locale-compat",
      "path": "dsh-desktop/assets/plugins/dsh-eac-locale-compat",
      "runtimeUpdate": {
        "allowed": false,
        "defaultAction": "prompt"
      },
      "source": {
        "kind": "unknown",
        "reason": "package.json does not declare a source repository; do not infer one from the directory name"
      },
      "syncMode": "manual"
    },
    "easy-setup": {
      "class": "internal",
      "kind": "plugin",
      "packageName": "@deepseek-ai/dsh-easy-setup",
      "path": "dsh-desktop/assets/plugins/dsh-easy-setup",
      "runtimeUpdate": {
        "allowed": false,
        "defaultAction": "prompt"
      },
      "source": {
        "kind": "internal",
        "name": "@deepseek-ai/dsh-easy-setup",
        "reason": "maintained in this repository; no external source is declared"
      },
      "syncMode": "manual"
    },
    "file-changes": {
      "class": "internal",
      "kind": "plugin",
      "packageName": "@deepseek-ai/dsh-file-changes",
      "path": "dsh-desktop/assets/plugins/dsh-file-changes",
      "runtimeUpdate": {
        "allowed": false,
        "defaultAction": "prompt"
      },
      "source": {
        "kind": "internal",
        "name": "@deepseek-ai/dsh-file-changes",
        "reason": "maintained in this repository; no external source is declared"
      },
      "syncMode": "manual"
    },
    "file-drop-eac": {
      "class": "internal",
      "kind": "plugin",
      "packageName": "dsh-file-drop-eac",
      "path": "dsh-desktop/assets/plugins/dsh-file-drop-eac",
      "runtimeUpdate": {
        "allowed": false,
        "defaultAction": "prompt"
      },
      "source": {
        "kind": "internal",
        "name": "dsh-file-drop-eac",
        "reason": "maintained in this repository; no external source is declared"
      },
      "syncMode": "manual"
    },
    "float-window": {
      "class": "internal",
      "kind": "plugin",
      "packageName": "@deepseek-ai/dsh-float-window",
      "path": "dsh-desktop/assets/plugins/dsh-float-window",
      "runtimeUpdate": {
        "allowed": false,
        "defaultAction": "prompt"
      },
      "source": {
        "kind": "internal",
        "name": "@deepseek-ai/dsh-float-window",
        "reason": "maintained in this repository; no external source is declared"
      },
      "syncMode": "manual"
    },
    "font-custom": {
      "class": "manual",
      "kind": "plugin",
      "packageName": "dsh-font-custom",
      "path": "dsh-desktop/assets/plugins/dsh-font-custom",
      "runtimeUpdate": {
        "allowed": false,
        "defaultAction": "prompt"
      },
      "source": {
        "kind": "unknown",
        "reason": "package.json does not declare a source repository; do not infer one from the directory name"
      },
      "syncMode": "manual"
    },
    "image-paste": {
      "class": "manual",
      "kind": "plugin",
      "packageName": "dsh-image-paste",
      "path": "dsh-desktop/assets/plugins/dsh-image-paste",
      "runtimeUpdate": {
        "allowed": false,
        "defaultAction": "prompt"
      },
      "source": {
        "kind": "unknown",
        "reason": "package.json does not declare a source repository; do not infer one from the directory name"
      },
      "syncMode": "manual"
    },
    "meow-smooth": {
      "class": "follow-upstream",
      "kind": "plugin",
      "packageName": "meow-smooth",
      "path": "dsh-desktop/assets/plugins/dsh-meow-smooth",
      "runtimeUpdate": {
        "allowed": false,
        "defaultAction": "prompt"
      },
      "source": {
        "kind": "github",
        "repository": "git+https://github.com/Phant0Meow/dsh-meow-smooth.git"
      },
      "syncMode": "mirror"
    },
    "message-rewind": {
      "class": "manual",
      "kind": "plugin",
      "packageName": "dsh-message-rewind",
      "path": "dsh-desktop/assets/plugins/dsh-message-rewind",
      "runtimeUpdate": {
        "allowed": false,
        "defaultAction": "prompt"
      },
      "source": {
        "kind": "unknown",
        "reason": "package.json does not declare a source repository; do not infer one from the directory name"
      },
      "syncMode": "manual"
    },
    "mobile-fix": {
      "class": "follow-upstream",
      "kind": "plugin",
      "packageName": "dsh-web-mobile-fix",
      "path": "dsh-desktop/assets/plugins/dsh-web-mobile-fix",
      "runtimeUpdate": {
        "allowed": true,
        "defaultAction": "prompt",
        "source": {
          "kind": "npm",
          "name": "dsh-web-mobile-fix"
        }
      },
      "source": {
        "kind": "npm",
        "name": "dsh-web-mobile-fix",
        "repository": "git+https://github.com/AcidGr/dsh-web-mobile-fix.git"
      },
      "syncMode": "mirror"
    },
    "offpeak": {
      "class": "follow-upstream",
      "kind": "plugin",
      "packageName": "dsh-offpeak",
      "path": "dsh-desktop/assets/plugins/dsh-offpeak",
      "runtimeUpdate": {
        "allowed": true,
        "defaultAction": "prompt",
        "source": {
          "kind": "npm",
          "name": "dsh-offpeak"
        }
      },
      "source": {
        "kind": "npm",
        "name": "dsh-offpeak",
        "repository": "git+https://github.com/christophersmith2737-commits/OffPeak.git"
      },
      "syncMode": "mirror"
    },
    "openclaw-bridge": {
      "class": "internal",
      "kind": "plugin",
      "packageName": "@deepseek-ai/dsh-openclaw-bridge",
      "path": "dsh-desktop/assets/plugins/dsh-openclaw-bridge",
      "runtimeUpdate": {
        "allowed": false,
        "defaultAction": "prompt"
      },
      "source": {
        "kind": "internal",
        "name": "@deepseek-ai/dsh-openclaw-bridge",
        "reason": "maintained in this repository; no external source is declared"
      },
      "syncMode": "manual"
    },
    "picturereader": {
      "class": "follow-upstream",
      "kind": "plugin",
      "packageName": "picturereader",
      "path": "dsh-desktop/assets/plugins/picturereader",
      "runtimeUpdate": {
        "allowed": true,
        "defaultAction": "prompt",
        "source": {
          "kind": "npm",
          "name": "picturereader"
        }
      },
      "source": {
        "kind": "npm",
        "name": "picturereader",
        "repository": "https://github.com/jing-hy/picturereader.git"
      },
      "syncMode": "mirror"
    },
    "plugin-manager": {
      "class": "internal",
      "kind": "plugin",
      "packageName": "@deepseek-ai/dsh-plugin-manager",
      "path": "dsh-desktop/assets/plugins/dsh-plugin-manager",
      "runtimeUpdate": {
        "allowed": false,
        "defaultAction": "prompt"
      },
      "source": {
        "kind": "internal",
        "name": "@deepseek-ai/dsh-plugin-manager",
        "reason": "maintained in this repository; no external source is declared"
      },
      "syncMode": "manual"
    },
    "plugin-shield": {
      "class": "manual",
      "kind": "plugin",
      "packageName": "dsh-plugin-shield",
      "path": "dsh-desktop/assets/plugins/dsh-plugin-shield",
      "runtimeUpdate": {
        "allowed": false,
        "defaultAction": "prompt"
      },
      "source": {
        "kind": "unknown",
        "reason": "package.json does not declare a source repository; do not infer one from the directory name"
      },
      "syncMode": "manual"
    },
    "plugin-wizard": {
      "class": "manual",
      "kind": "plugin",
      "packageName": "dsh-plugin-wizard",
      "path": "dsh-desktop/assets/plugins/dsh-plugin-wizard",
      "runtimeUpdate": {
        "allowed": false,
        "defaultAction": "prompt"
      },
      "source": {
        "kind": "unknown",
        "reason": "package.json does not declare a source repository; do not infer one from the directory name"
      },
      "syncMode": "manual"
    },
    "prompt-custom": {
      "class": "internal",
      "kind": "plugin",
      "packageName": "@deepseek-ai/dsh-prompt-custom",
      "path": "dsh-desktop/assets/plugins/dsh-prompt-custom",
      "runtimeUpdate": {
        "allowed": false,
        "defaultAction": "prompt"
      },
      "source": {
        "kind": "internal",
        "name": "@deepseek-ai/dsh-prompt-custom",
        "reason": "maintained in this repository; no external source is declared"
      },
      "syncMode": "manual"
    },
    "sample-sdk-plugin": {
      "class": "isolated-sdk",
      "kind": "sdk-plugin",
      "packageName": "sample-sdk-plugin",
      "path": "dsh-desktop/assets/sdk-plugins/sample-sdk-plugin",
      "runtimeUpdate": {
        "allowed": false,
        "defaultAction": "prompt"
      },
      "source": {
        "kind": "internal",
        "name": "sample-sdk-plugin",
        "reason": "SDK fixture maintained with the desktop repository"
      },
      "syncMode": "manual"
    },
    "settings-groups": {
      "class": "manual",
      "kind": "plugin",
      "packageName": "dsh-settings-groups",
      "path": "dsh-desktop/assets/plugins/dsh-settings-groups",
      "runtimeUpdate": {
        "allowed": false,
        "defaultAction": "prompt"
      },
      "source": {
        "kind": "unknown",
        "reason": "package.json does not declare a source repository; do not infer one from the directory name"
      },
      "syncMode": "manual"
    },
    "settings-scroll-fix": {
      "class": "internal",
      "kind": "plugin",
      "packageName": "dsh-settings-scroll-fix",
      "path": "dsh-desktop/assets/plugins/dsh-settings-scroll-fix",
      "runtimeUpdate": {
        "allowed": false,
        "defaultAction": "prompt"
      },
      "source": {
        "kind": "internal",
        "name": "dsh-settings-scroll-fix",
        "reason": "maintained in this repository; no external source is declared"
      },
      "syncMode": "manual"
    },
    "side-session": {
      "class": "internal",
      "kind": "plugin",
      "packageName": "@dsh-external/dsh-side-session",
      "path": "dsh-desktop/assets/plugins/dsh-side-session",
      "runtimeUpdate": {
        "allowed": false,
        "defaultAction": "prompt"
      },
      "source": {
        "kind": "internal",
        "name": "@dsh-external/dsh-side-session",
        "reason": "maintained in this repository; no external source is declared"
      },
      "syncMode": "manual"
    },
    "skin-switch": {
      "class": "internal",
      "kind": "plugin",
      "packageName": "@deepseek-ai/dsh-skin-switch",
      "path": "dsh-desktop/assets/plugins/dsh-skin-switch",
      "runtimeUpdate": {
        "allowed": false,
        "defaultAction": "prompt"
      },
      "source": {
        "kind": "internal",
        "name": "@deepseek-ai/dsh-skin-switch",
        "reason": "maintained in this repository; no external source is declared"
      },
      "syncMode": "manual"
    },
    "soul-md": {
      "class": "follow-upstream",
      "kind": "plugin",
      "packageName": "dsh-soul-md",
      "path": "dsh-desktop/assets/plugins/dsh-soul-md",
      "runtimeUpdate": {
        "allowed": true,
        "defaultAction": "prompt",
        "source": {
          "kind": "npm",
          "name": "dsh-soul-md"
        }
      },
      "source": {
        "kind": "npm",
        "name": "dsh-soul-md",
        "repository": "git+https://github.com/Scorp1o117/dsh-soul-md.git"
      },
      "syncMode": "mirror"
    },
    "terminal": {
      "class": "internal",
      "kind": "plugin",
      "packageName": "@deepseek-ai/dsh-terminal",
      "path": "dsh-desktop/assets/plugins/dsh-terminal",
      "runtimeUpdate": {
        "allowed": false,
        "defaultAction": "prompt"
      },
      "source": {
        "kind": "internal",
        "name": "@deepseek-ai/dsh-terminal",
        "reason": "maintained in this repository; no external source is declared"
      },
      "syncMode": "manual"
    },
    "think-zh-expand-eac": {
      "class": "follow-upstream",
      "kind": "plugin",
      "packageName": "dsh-think-zh-expand-eac",
      "path": "dsh-desktop/assets/plugins/dsh-think-zh-expand-eac",
      "runtimeUpdate": {
        "allowed": true,
        "defaultAction": "prompt",
        "source": {
          "kind": "github",
          "repository": "https://github.com/jing-hy/dsh-think-zh-expand-eac"
        }
      },
      "source": {
        "kind": "github",
        "repository": "https://github.com/jing-hy/dsh-think-zh-expand-eac"
      },
      "syncMode": "mirror"
    },
    "ui-skin-blue-fantasy": {
      "class": "resource",
      "kind": "skin",
      "packageName": "@linxin666/dsh-client-ui-skin-blue-fantasy",
      "path": "dsh-desktop/assets/skins/blue-fantasy",
      "runtimeUpdate": {
        "allowed": false,
        "defaultAction": "prompt"
      },
      "source": {
        "kind": "github",
        "repository": "https://github.com/zhu1090093659/dsh-web-ui.git"
      },
      "syncMode": "metadata-only"
    },
    "ui-skin-dragon-heir": {
      "class": "resource",
      "kind": "skin",
      "packageName": "@linxin666/dsh-client-ui-skin-dragon-heir",
      "path": "dsh-desktop/assets/skins/dragon-heir",
      "runtimeUpdate": {
        "allowed": false,
        "defaultAction": "prompt"
      },
      "source": {
        "kind": "github",
        "repository": "https://github.com/zhu1090093659/dsh-web-ui.git"
      },
      "syncMode": "metadata-only"
    },
    "ui-skin-maid-atelier": {
      "class": "resource",
      "kind": "skin",
      "packageName": "@dsh-external/dsh-client-ui-skin-maid-atelier",
      "path": "dsh-desktop/assets/skins/maid-atelier",
      "runtimeUpdate": {
        "allowed": false,
        "defaultAction": "prompt"
      },
      "source": {
        "kind": "internal",
        "name": "@dsh-external/dsh-client-ui-skin-maid-atelier",
        "reason": "maintained in this repository; no external source is declared"
      },
      "syncMode": "metadata-only"
    },
    "ui-skin-miku": {
      "class": "resource",
      "kind": "skin",
      "packageName": "@linxin666/dsh-client-ui-skin-miku",
      "path": "dsh-desktop/assets/skins/miku",
      "runtimeUpdate": {
        "allowed": false,
        "defaultAction": "prompt"
      },
      "source": {
        "kind": "github",
        "repository": "https://github.com/zhu1090093659/dsh-web-ui.git"
      },
      "syncMode": "metadata-only"
    },
    "ui-skin-minecraft": {
      "class": "resource",
      "kind": "skin",
      "packageName": "@linxin666/dsh-client-ui-skin-minecraft",
      "path": "dsh-desktop/assets/skins/minecraft",
      "runtimeUpdate": {
        "allowed": false,
        "defaultAction": "prompt"
      },
      "source": {
        "kind": "github",
        "repository": "https://github.com/zhu1090093659/dsh-web-ui.git"
      },
      "syncMode": "metadata-only"
    },
    "ui-skin-qq98": {
      "class": "resource",
      "kind": "skin",
      "packageName": "@linxin666/dsh-client-ui-skin-qq98",
      "path": "dsh-desktop/assets/skins/qq98",
      "runtimeUpdate": {
        "allowed": false,
        "defaultAction": "prompt"
      },
      "source": {
        "kind": "github",
        "repository": "https://github.com/zhu1090093659/dsh-web-ui.git"
      },
      "syncMode": "metadata-only"
    },
    "ui-skin-ths": {
      "class": "resource",
      "kind": "skin",
      "packageName": "@linxin666/dsh-client-ui-skin-ths",
      "path": "dsh-desktop/assets/skins/ths",
      "runtimeUpdate": {
        "allowed": false,
        "defaultAction": "prompt"
      },
      "source": {
        "kind": "github",
        "repository": "https://github.com/zhu1090093659/dsh-web-ui.git"
      },
      "syncMode": "metadata-only"
    },
    "ui-skin-trading": {
      "class": "resource",
      "kind": "skin",
      "packageName": "@linxin666/dsh-client-ui-skin-trading",
      "path": "dsh-desktop/assets/skins/trading",
      "runtimeUpdate": {
        "allowed": false,
        "defaultAction": "prompt"
      },
      "source": {
        "kind": "github",
        "repository": "https://github.com/zhu1090093659/dsh-web-ui.git"
      },
      "syncMode": "metadata-only"
    },
    "ui-skin-whale-song": {
      "class": "resource",
      "kind": "skin",
      "packageName": "@linxin666/dsh-client-ui-skin-whale-song",
      "path": "dsh-desktop/assets/skins/whale-song",
      "runtimeUpdate": {
        "allowed": false,
        "defaultAction": "prompt"
      },
      "source": {
        "kind": "github",
        "repository": "https://github.com/zhu1090093659/dsh-web-ui.git"
      },
      "syncMode": "metadata-only"
    },
    "ui-skin-xp": {
      "class": "resource",
      "kind": "skin",
      "packageName": "@linxin666/dsh-client-ui-skin-xp",
      "path": "dsh-desktop/assets/skins/xp",
      "runtimeUpdate": {
        "allowed": false,
        "defaultAction": "prompt"
      },
      "source": {
        "kind": "github",
        "repository": "https://github.com/zhu1090093659/dsh-web-ui.git"
      },
      "syncMode": "metadata-only"
    },
    "unified-market": {
      "class": "follow-upstream",
      "kind": "plugin",
      "packageName": "dsh-unified-market",
      "path": "dsh-desktop/assets/plugins/dsh-unified-market",
      "runtimeUpdate": {
        "allowed": true,
        "defaultAction": "prompt",
        "source": {
          "kind": "npm",
          "name": "dsh-unified-market"
        }
      },
      "source": {
        "kind": "npm",
        "name": "dsh-unified-market",
        "repository": "git+https://github.com/jing-hy/dsh-unified-market.git"
      },
      "syncMode": "mirror"
    },
    "viewport-lock": {
      "class": "internal",
      "kind": "plugin",
      "packageName": "dsh-viewport-lock",
      "path": "dsh-desktop/assets/plugins/dsh-viewport-lock",
      "runtimeUpdate": {
        "allowed": false,
        "defaultAction": "prompt"
      },
      "source": {
        "kind": "internal",
        "name": "dsh-viewport-lock",
        "reason": "maintained in this repository; no external source is declared"
      },
      "syncMode": "manual"
    }
  },
  "manifest": ".sync/plugins.json",
  "schemaVersion": 1,
  "updateSources": {
    "better-sidebar": {
      "npm": "dsh-better-sidebar"
    },
    "computer-user": {
      "npm": "computer-user"
    },
    "dsh-navbar": {
      "npm": "@vlln/dsh-navbar"
    },
    "dsh-pet": {
      "npm": "dsh-pet"
    },
    "dsh-session-manager": {
      "npm": "dsh-session-manager"
    },
    "dsh-undo": {
      "github": "lire1131/dsh-undo-savepoint"
    },
    "mobile-fix": {
      "npm": "dsh-web-mobile-fix"
    },
    "offpeak": {
      "npm": "dsh-offpeak"
    },
    "picturereader": {
      "npm": "picturereader"
    },
    "soul-md": {
      "npm": "dsh-soul-md"
    },
    "think-zh-expand-eac": {
      "github": "jing-hy/dsh-think-zh-expand-eac"
    },
    "unified-market": {
      "npm": "dsh-unified-market"
    }
  }
} as const;
export const PLUGIN_UPDATE_SOURCES = PLUGIN_SYNC_REGISTRY.updateSources;
export default PLUGIN_SYNC_REGISTRY;
