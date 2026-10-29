VRC 0.1.74 PVE ARM 支持 CentOS Stream 9 无人值守安装。

- PVE ARM 无人值守安装新增 CentOS Stream 9（ARM64），与 openEuler / Kylin 并列可选；当前仅支持服务器安装。
- 自动剥离 RHEL 9 流程中仅适用于 XenServer 的内核兼容参数，避免污染 PVE（KVM）客户机的引导项。
- 安装结果提示按实际发行版名称展示。
