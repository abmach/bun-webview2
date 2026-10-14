// bun-webview2 native runner — owns one window + webview + message loop.
//
// This is the process that MUST NOT be a Bun process: after the 2026-10-14
// Windows security updates, WebView2 environment creation faults at address
// 0x0 inside EmbeddedBrowserWebView.dll when hosted by bun.exe (any thread,
// any loader mode), while plain native executables work. The runner is a
// plain C++ executable; the parent Bun process keeps full control of the
// page over CDP and receives window events as JSON lines on stdout.
//
// Protocol (identical to the TypeScript host it replaces):
//   argv[last]        = JSON config {title, width, height, minWidth?, minHeight?}
//   stdout            = one JSON object per line: window events + {"event":"closed"}
//   page -> runner    = bwv2_host_cmd("<command json>") via webview_bind;
//                       reply flows through webview_return, so the page-side
//                       promise the parent awaits resolves = command applied
//
// Build (zig c++, no MSVC, no cmake):
//   zig c++ -std=c++17 -O2 -DWEBVIEW_MSWEBVIEW2_BUILTIN_IMPL=0 \
//     -I <webview-src>/core/include -I <webview-src>/compatibility/mingw/include \
//     -I <webview2-sdk>/build/native/include \
//     native/runner.cc <webview-src>/core/src/webview.cc \
//     <webview2-sdk>/build/native/x64/WebView2Loader.dll.lib \
//     -ladvapi32 -lole32 -lshell32 -lshlwapi -luser32 -lversion \
//     -o native/runner.exe

#include "webview/webview.h"
#include "webview/detail/json.hh"

#include <windows.h>
#include <shellapi.h>
#include <propsys.h>
#include <shobjidl.h>
#include <propkey.h>
#include <shlwapi.h>
#include <cstdio>
#include <cstring>
#include <filesystem>
#include <string>

namespace {

// --- window events via WndProc subclassing ---------------------------------
// Only non-client, window-level messages reach this procedure: input over the
// page surface goes to the WebView2 child HWND and is delivered to apps as
// page DOM events by the parent's injected bridge.





















void emit(const std::string &line) {
  std::fputs(line.c_str(), stdout);
  std::fputc('\n', stdout);
  std::fflush(stdout);
}

void emit_event(const std::string &name, const std::string &fields = "") {
  emit("{\"event\":\"" + name + "\"" + (fields.empty() ? "" : "," + fields) + "}");
}

std::string number(double v) {
  auto as_long = static_cast<long long>(v);
  if (v == static_cast<double>(as_long)) {
    return std::to_string(as_long);
  }
  return std::to_string(v);
}

webview_t g_handle = nullptr;
HWND g_hwnd = nullptr;
WNDPROC g_original_proc = nullptr;

std::string theme_text() {
  DWORD value = 0;
  DWORD size = sizeof(value);
  if (RegGetValueW(HKEY_CURRENT_USER,
                   L"Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize",
                   L"AppsUseLightTheme", RRF_RT_REG_DWORD, nullptr, &value, &size) == 0 &&
      value == 1) {
    return "light";
  }
  return "dark";
}

LRESULT CALLBACK runner_wndproc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
  switch (msg) {
  case WM_MOVE:
    emit_event("move",
               "\"x\":" + std::to_string(static_cast<short>(LOWORD(lp))) +
                   ",\"y\":" + std::to_string(static_cast<short>(HIWORD(lp))));
    break;
  case WM_SIZE:
    emit_event("resize",
               "\"width\":" + std::to_string(LOWORD(lp)) +
                   ",\"height\":" + std::to_string(HIWORD(lp)));
    break;
  case WM_ACTIVATE:
    // window activation: clicks on the page activate the top window too,
    // unlike WM_SETFOCUS which the WebView2 child HWND claims
    emit_event(LOWORD(wp) != 0 ? "focus" : "blur");
    break;
  case WM_THEMECHANGED:
    emit_event("theme-changed", "\"text\":\"" + theme_text() + "\"");
    break;
  default:
    break;
  }
  if (g_original_proc != nullptr) {
    return CallWindowProcW(g_original_proc, hwnd, msg, wp, lp);
  }
  return DefWindowProcW(hwnd, msg, wp, lp);
}

// --- command channel: page -> webview_bind -> here ------------------------

std::string apply_command(const std::string &op, const std::string &args_json) {
  const auto arg = [&args_json](int index) {
    return webview::detail::json_parse(args_json, "", index);
  };
  if (op == "hello") {
    return "true";
  }
  if (op == "setTitle") {
    webview_set_title(g_handle, arg(0).c_str());
    return "0";
  }
  if (op == "setSize") {
    webview_set_size(g_handle, std::atoi(arg(0).c_str()), std::atoi(arg(1).c_str()),
                     WEBVIEW_HINT_NONE);
    return "0";
  }
  if (op == "setPosition") {
    SetWindowPos(g_hwnd, nullptr, std::atoi(arg(0).c_str()), std::atoi(arg(1).c_str()), 0, 0,
                 SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE);
    return "0";
  }
  if (op == "setDecorations") {
    auto current = GetWindowLongPtrW(g_hwnd, GWL_STYLE);
    auto masked = current & ~WS_OVERLAPPEDWINDOW;
    auto updated = arg(0) == "true" ? masked | WS_OVERLAPPEDWINDOW : masked;
    SetWindowLongPtrW(g_hwnd, GWL_STYLE, updated);
    SetWindowPos(g_hwnd, nullptr, 0, 0, 0, 0,
                 SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_FRAMECHANGED);
    return "0";
  }
  if (op == "setAlwaysOnTop") {
    SetWindowPos(g_hwnd, arg(0) == "true" ? HWND_TOPMOST : HWND_NOTOPMOST, 0, 0, 0, 0,
                 SWP_NOMOVE | SWP_NOSIZE);
    return "0";
  }
  if (op == "focus") {
    return std::to_string(SetForegroundWindow(g_hwnd));
  }
  if (op == "minimize") {
    return std::to_string(ShowWindow(g_hwnd, SW_MINIMIZE));
  }
  if (op == "maximize") {
    return std::to_string(ShowWindow(g_hwnd, SW_MAXIMIZE));
  }
  if (op == "close") {
    // restore the original procedure before tearing the window down
    if (g_original_proc != nullptr) {
      SetWindowLongPtrW(g_hwnd, GWLP_WNDPROC, reinterpret_cast<LONG_PTR>(g_original_proc));
      g_original_proc = nullptr;
    }
    webview_terminate(g_handle);
    return "true";
  }
  return "null";
}

void on_command(const char *id, const char *req, void * /*arg*/) {
  // req is a JSON array of the call arguments; element 0 is our command payload
  auto payload = webview::detail::json_parse(req, "", 0);
  const auto op = webview::detail::json_parse(payload, "op", 0);
  const auto args = webview::detail::json_parse(payload, "args", 0);
  std::string result = "null";
  try {
    result = apply_command(op, args);
  } catch (const std::exception &e) {
    std::fprintf(stderr, "[runner] command '%s' failed: %s\n", op.c_str(), e.what());
  }
  webview_return(g_handle, id, 0, result.c_str());
}

// --- app icon and taskbar identity -----------------------------------------
// The runner owns the HWND, so the app's icon must be applied here: the C
// library sets a generic stock icon on its window class. An AppUserModelID
// makes Windows group and label the window as the app, not as "runner".

bool apply_icon(const std::string &icon_path, const std::string &app_name) {
  if (icon_path.empty()) {
    return false;
  }
  std::wstring wide_path(icon_path.size(), L'\0');
  auto path_len = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, icon_path.c_str(),
                                      static_cast<int>(icon_path.size()), wide_path.data(),
                                      static_cast<int>(icon_path.size()));
  if (path_len <= 0) {
    return false;
  }
  wide_path.resize(path_len);
  auto big = LoadImageW(nullptr, wide_path.c_str(), IMAGE_ICON, GetSystemMetrics(SM_CXICON),
                         GetSystemMetrics(SM_CYICON), LR_LOADFROMFILE);
  auto small = LoadImageW(nullptr, wide_path.c_str(), IMAGE_ICON, 16, 16, LR_LOADFROMFILE);
  if (big == nullptr && small == nullptr) {
    std::fprintf(stderr, "[runner] icon load failed: %s (GetLastError=%lu)\n",
                  icon_path.c_str(), GetLastError());
    return false;
  }
  if (big != nullptr) {
    SendMessageW(g_hwnd, WM_SETICON, ICON_BIG, reinterpret_cast<LPARAM>(big));
  }
  if (small != nullptr) {
    SendMessageW(g_hwnd, WM_SETICON, ICON_SMALL, reinterpret_cast<LPARAM>(small));
  }
  // update the class icon so future windows of the same class inherit it
  if (big != nullptr) {
    SetClassLongPtrW(g_hwnd, GCLP_HICON, reinterpret_cast<LONG_PTR>(static_cast<HICON>(big)));
  }

  // AppUserModelID: taskbar groups by this, so set it per app (falls back to
  // the runner's identity when absent)
  if (!app_name.empty()) {
    std::wstring aumid(L"bun-webview2.");
    aumid += std::wstring(app_name.begin(), app_name.end());
    for (auto &c : aumid) {
      if (c == L' ' || c == L'.' || c == L'\\' || c == L'/') {
        c = L'_';
      }
    }
    // the shell reads AUMID from the property store — the only mechanism
    // that matters; SetPropW would be a no-op that leaks a global atom
    IPropertyStore *store = nullptr;
    auto hwnd_ptr = static_cast<HWND>(g_hwnd);
    if (SUCCEEDED(SHGetPropertyStoreForWindow(hwnd_ptr, IID_IPropertyStore,
                                             reinterpret_cast<void **>(&store)))) {
      PROPVARIANT variant;
      PropVariantInit(&variant);
      variant.vt = VT_LPWSTR;
      variant.pwszVal = const_cast<LPWSTR>(aumid.c_str());
      store->SetValue(PKEY_AppUserModel_ID, variant);
      store->Release();
    }
  }
  return true;
}

// --- standalone runtime resolution -----------------------------------------
// Windows Update services the standalone WebView2 runtime
// (EdgeWebView\Application) while the Edge channel's copy can go stale and
// crash on environment creation. Prefer the standalone tree when present.

void resolve_standalone_runtime() {
  if (GetEnvironmentVariableW(L"WEBVIEW2_BROWSER_EXECUTABLE_FOLDER", nullptr, 0) != 0) {
    return; // explicit user choice
  }
  const std::wstring root = L"C:\\Program Files (x86)\\Microsoft\\EdgeWebView\\Application";
  std::error_code ec;
  if (!std::filesystem::is_directory(root, ec)) {
    return;
  }
  std::wstring newest;
  for (const auto &entry : std::filesystem::directory_iterator(root, ec)) {
    if (!entry.is_directory()) {
      continue;
    }
    const auto dir = entry.path().filename().wstring();
    if (dir.find_first_not_of(L"0123456789.") != std::wstring::npos) {
      continue; // version-shaped names only
    }
    if (!std::filesystem::exists(entry.path() / L"msedgewebview2.exe", ec)) {
      continue;
    }
    if (newest.empty() || dir > newest) {
      newest = dir;
    }
  }
  if (!newest.empty()) {
    const auto folder = root + L"\\" + newest;
    SetEnvironmentVariableW(L"WEBVIEW2_BROWSER_EXECUTABLE_FOLDER", folder.c_str());
  }
}

} // namespace

int main(int argc, char **argv) {
  const std::string config =
      argc > 1 ? argv[argc - 1] : "{}";
  const auto title = webview::detail::json_parse(config, "title", 0);
  const auto width = webview::detail::json_parse(config, "width", 0);
  const auto height = webview::detail::json_parse(config, "height", 0);
  const auto min_width = webview::detail::json_parse(config, "minWidth", 0);
  const auto min_height = webview::detail::json_parse(config, "minHeight", 0);
  const auto icon_path = webview::detail::json_parse(config, "icon", 0);

  resolve_standalone_runtime();

  g_handle = webview_create(0, nullptr);
  if (g_handle == nullptr) {
    std::fprintf(stderr, "[runner] webview_create failed\n");
    return 1;
  }
  g_hwnd = static_cast<HWND>(webview_get_window(g_handle));
  g_original_proc = reinterpret_cast<WNDPROC>(SetWindowLongPtrW(
      g_hwnd, GWLP_WNDPROC, reinterpret_cast<LONG_PTR>(runner_wndproc)));

  webview_set_title(g_handle,
                     (title.empty() ? "bun-webview2" : title).c_str());
  webview_set_size(g_handle, width.empty() ? 800 : std::atoi(width.c_str()),
                   height.empty() ? 600 : std::atoi(height.c_str()), WEBVIEW_HINT_NONE);
  if (!min_width.empty() && !min_height.empty()) {
    // the track-size minimum is in OUTER coordinates; compensate the frame
    // so the minimum applies to the client area
    RECT outer{};
    RECT inner{};
    GetWindowRect(g_hwnd, &outer);
    GetClientRect(g_hwnd, &inner);
    const auto frame_w = (outer.right - outer.left) - (inner.right - inner.left);
    const auto frame_h = (outer.bottom - outer.top) - (inner.bottom - inner.top);
    webview_set_size(g_handle, std::atoi(min_width.c_str()) + frame_w,
                     std::atoi(min_height.c_str()) + frame_h, WEBVIEW_HINT_MIN);
  }
  webview_bind(g_handle, "bwv2_host_cmd", on_command, nullptr);
  apply_icon(icon_path, title.empty() ? "app" : title);
  // inert initial document; the parent drives all real content over CDP
  webview_navigate(g_handle, "about:blank");

  webview_run(g_handle);
  // run() returning means the window closed (user close or the "close" op)
  emit_event("closed");
  return 0;
}
