---
status: accepted
---

# Provider Card 编辑经测试发布后才生效

已发布 PI Provider Card 的修改先保存为 Draft，不影响当前 Active revision。Draft 通过生产同路径模型测试后，系统管理员显式发布，新的 Active revision 原子供所有新 ManagementRun 使用；已经开始的 Run 固定使用启动时的 Card revision，不在任务中途切换 Endpoint 或配置。

Active PI Model 的 Model ID 不因模型目录刷新而自动变化。正在被 Active PI Model 使用的 Card 不能直接删除，只能先切换全局模型。Credential 轮换可以保持稳定 `credentialRef`，不要求改变 Active PI Model。该双版本机制提供安全编辑与切换，但不引入复杂的多环境发布流水线。
