# sample-python-app

用于 dsh-projectops 依赖分析的示例项目。

注意 `app/service.py` 与 `app/models.py` 之间存在真实的 import 循环（`service -> models -> service`），
`main.py -> app.service` 是正常依赖，`json`/`os` 会被统计为外部依赖。
