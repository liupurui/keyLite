// Windows 下隐藏控制台窗口；macOS 上无影响
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    keylite_lib::run()
}
