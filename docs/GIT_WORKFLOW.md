# Git проекта CodeHead

24 ноября 2026 года автор поручил начать ведение Git и заливку проекта в аккаунт [alexsashka1771](https://github.com/alexsashka1771). Создан приватный репозиторий [alexsashka1771/codehead](https://github.com/alexsashka1771/codehead); глобальные настройки Git не меняются. `origin` использует username alexsashka1771 для однозначного выбора аккаунта Git Credential Manager.

`main` хранит проверенную основу. Кандидат Clinic Demo сохранён в `feat/clinic-candidate`, Runner 4.1 в `codex/runner-checks`, QA и repair 4.2 в `codex/qa-repair`. DevOps и preview 4.3 ведутся в `codex/devops-preview` от `ed6ab36`. После проверок каждого шага создаётся один осмысленный коммит с сообщением в формате conventional commits на английском. Обычные commit/push этого проекта разрешены поручением автора о ведении Git. Force push, reset --hard, удаление истории и веток и смена видимости требуют отдельного решения.

Коммиты используют публичную GitHub-идентичность автора через окружение текущего процесса:

```powershell
$env:GIT_AUTHOR_NAME = "Alexander Lanskoy"
$env:GIT_AUTHOR_EMAIL = "244291936+alexsashka1771@users.noreply.github.com"
$env:GIT_COMMITTER_NAME = $env:GIT_AUTHOR_NAME
$env:GIT_COMMITTER_EMAIL = $env:GIT_AUTHOR_EMAIL
```

Git Credential Manager обслуживает вход в GitHub. Ключи не записываются в проект и не копируются из чужих конфигураций. В репозиторий входят исходники, lockfiles, профили, тесты, документация и необходимые публичные ресурсы. `.data`, PostgreSQL/SQLite, окружения, node_modules, сборки, отчёты, приватные ключи и `.env` исключены; `.env.example` содержит только шаблон переменных. Локальные ссылки отчётов на `.data` доступны на машине автора и не публикуются.

Перед коммитом проверяются staged diff и секреты. Локальный pre-commit hook вызывает `tools/git_guard.py` и `git diff --cached --check`; он не выводит значения обнаруженных ключей. После нового clone hook устанавливается без изменения git config:

```powershell
Copy-Item -LiteralPath ".githooks\pre-commit" -Destination ".git\hooks\pre-commit"
```

Для кода запускаются подходящие проверки `npm run check`, `npm run test:backend`, `npm run build` и затронутые E2E. Для документации достаточно её целевых проверок и guard; повтор всех тестов без изменения кода не требуется. Перед push проверяются адрес origin, ветка, список коммитов и отсутствие приватных файлов. После push сверяется удалённый SHA.
