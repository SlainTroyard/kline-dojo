# 常驻部署（systemd user units）

终端里 `nohup` 起的进程会随会话退出而死。装成 systemd user 服务可获得：
开机自启、崩溃自动重启、每日 01:30 自动增量刷新指数（配合 astock 的 01:00 更新，
早上打开看板即最新，无需手动点「⟳ 同步数据」）。

```bash
cd /path/to/kline-dojo    # ← 改成你的项目路径
sed -i 's|/path/to/kline-dojo|你的实际路径|' deploy/*.service  # 先替换占位路径
cp deploy/baozhu.service deploy/baozhu-refresh.service deploy/baozhu-refresh.timer \
   ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now baozhu.service baozhu-refresh.timer

# 常用命令
systemctl --user status baozhu
journalctl --user -u baozhu -f              # 看服务日志
systemctl --user restart baozhu             # 改代码后重启生效
```

- `baozhu.service`：常驻服务，8870 端口，Restart=on-failure
- `baozhu-refresh.timer`：每天 01:30 跑一次 `bz_index.py`（增量刷新全部指数）
- 若项目目录改名，同步改 unit 里的 WorkingDirectory
- 卸载：`systemctl --user disable --now baozhu baozhu-refresh.timer && rm ~/.config/systemd/user/baozhu*`
