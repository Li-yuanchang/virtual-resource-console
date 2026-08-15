VRC 0.1.70 支持 RHEL 系镜像无人值守安装并优化 Rocky 9 安装稳定性。

- 创建虚拟机选择 RHEL 系镜像（Rocky / CentOS / Alma / Oracle）时自动路由到无人值守 kickstart 策略；Rocky 9 改走 xen_nopv 模拟设备并跳过 xs-tools。
- 安装源 HTTP 服务优化分块传输与连接处理，排除固件驱动包，降低老 XenServer 网络下大文件传输中断概率。
- 安装验收区分安装器环境与装好的系统，避免安装未完成被误判成功；SSH 探测到真实系统标识后写回平台“系统”列。
