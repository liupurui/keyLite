import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { SearchWindow } from "./screens/SearchWindow";
import { isTauri } from "./lib/api";
import "./styles.css";

const root = ReactDOM.createRoot(document.getElementById("root") as HTMLElement);

async function boot() {
  // 独立窗口（label = search）只渲染搜索界面，且背景透明以便圆角与阴影生效
  if (isTauri()) {
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      if (getCurrentWindow().label === "search") {
        document.documentElement.dataset.window = "search";
        root.render(<SearchWindow />);
        return;
      }
    } catch {
      /* 拿不到窗口信息就走正常路径 */
    }
  }

  root.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
}

boot();
