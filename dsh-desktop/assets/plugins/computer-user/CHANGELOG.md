# Changelog

## 0.1.0 (2026-08-21)

- Initial release: `computer_screenshot` + `computer_click` / `computer_type` /
  `computer_keypress` / `computer_scroll` / `computer_drag` / `computer_move_mouse` /
  `computer_wait` / `computer_get_cursor_position`.
- PowerShell + Win32 SendInput backend (Windows only, zero native deps).
- Settings card with up-front **Enabled** / **Ask-before-acting** switches and a
  default-collapsed Advanced section.
- Works with picturereader to close the look → act → verify loop.
- Node:test unit suite; safe-window smoke scripts; headless integration verified.
