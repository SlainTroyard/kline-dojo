# 常驻部署（systemd user units）

终端里 `nohup` 起的进程会随会话退出而死。装成 systemd user 服务可获得：
开机自启、崩溃自动重启、每日 01:30 自动增量刷新指数（早上打开看板即最新，
无需手动点「⟳ 同步数据」）。

```bash
cd /path/to/kline-dojo    # ← 改成你的项目路径
sed -i 's|/path/to/kline-dojo|你的实际路径|' deploy/*.service  # 先替换占位路径
cp deploy/kline-dojo.service deploy/kline-dojo-refresh.service deploy/kline-dojo-refresh.timer \
   ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now kline-dojo.service kline-dojo-refresh.timer

# 常用命令
systemctl --user status kline-dojo
journalctl --user -u kline-dojo -f          # 看服务日志
systemctl --user restart kline-dojo         # 改代码后重启生效
```

- `kline-dojo.service`：常驻服务，8870 端口，Restart=on-failure
- `kline-dojo-refresh.timer`：每天 01:30 跑一次 `dojo_index.py`（增量刷新全部指数）
- 若项目目录改名，同步改 unit 里的 WorkingDirectory
- 卸载：`systemctl --user disable --now kline-dojo kline-dojo-refresh.timer && rm ~/.config/systemd/user/kline-dojo*`
- 如果装过旧的 `baozhu*` 单元，先 `systemctl --user disable --now baozhu baozhu-refresh.timer` 并删除旧文件，再安装新单元
