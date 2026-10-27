# Compose — фактический статус

## Windows installer · 28.10.2026

Текущий NSIS setup собран и проверен:
02_application/release/compose-installer/SC2 Adjutant Compose_1.1.11_x64-setup.exe
(430984064 bytes / 411.02 MiB). SHA256:
23a2d02e43f86209e8f61b7df5c27945642e1cc12d2420c571b09620dc35e2e4.
Per-user, RU/EN, встроенные Node/карты/OBS HTML. WebView2 downloadBootstrapper
нужен только при отсутствии runtime. Подпись NotSigned, публикации нет.

Реальная установка в отдельный путь с кириллицей PASS: EXE + 256 ресурсов
проверены по SHA256, native WebView/IPC/SQLite/OBS HTTP и replay/map/restart PASS,
тестовая деинсталляция PASS, регистрация удалена. Rhoskallian LE: 4 игрока,
2 команды, 574 потери, editor background 2048×2048; исходный replay сохранён.
Reports под 02_application/.compose-test-data:
installer-3d56aab14e7f4ef38e02f6016b637547/report.json;
smoke-8c011fdaaa4648f08b63163f0f59abd7/report.json.
Исходный check.ps1 повторно PASS: 673 Python / 130 Node, 2 прежних warnings.

Добавлены stage-compose-installer.cjs (setup + SHA256SUMS + README) и opt-in
check-compose-installer.ps1. Проверка учитывает единственный NSIS bundle marker
Tauri, сверяя остальные байты установленного EXE с текущим build. Тест отказывается
заменять зарегистрированную Compose-установку; Electron не заменяется.
Установка на машине без WebView2, GUI шаги мастера и upgrade существующего
рабочего профиля отдельно не проверялись. Инструкция: [INSTALLATION.md](INSTALLATION.md).

## Фоны карты потерь · 28.10.2026

Реализован переносимый локальный resolver: последний primary s2ma cache handle
реплея → точный SHA256 → экспорт Map Editor → сохранённый PNG → миникарта из
точного локального SC2-архива. Название карты не используется для подбора версии.
В ресурсах приложения 35 PNG (234.4 MiB), 40 подтверждённых версий 33 карт;
Fields of Death CE и Sentinel CE имеют неподтверждённые экспорты и идут через
миникарту соответствующей версии. Работает также для командных карт.

Миникарта читается без запуска SC2/редактора и без сети: стандартные Blizzard
cache roots, проверка SHA всего .s2ma, bounded MPQ0–3, MapInfo и Minimap.tga.
Нормализуется TGA origin, убираются внешние поля; размеры/аспект/границы проверяются.
PNG и descriptor сохраняются в profile/map-backgrounds; публичный GET выдаёт
только PNG по хешу содержимого. Исходники read-only. Повреждение/отсутствие карты
не ломает анализ: показывается схема. Регистрация по camera bounds приблизительная,
независимая калибровка по контрольным точкам не выполнена.

Фактические gates: 369 TS / 71 Rust PASS, typecheck/fmt/Clippy PASS, bank verifier
35 PNG/40 revisions PASS; explicit check_maps проверил все 40 editor revisions и
реальную миникарту из MPQ3. Optimized EXE обновлён в
02_application/release/compose-replay-fix-preview. Два реальных native smoke
на Rhoskallian LE с restart/HTTP/checksum/source preservation PASS:
editor — smoke-2b784a55183a4ce9885deab9928b491b;
forced minimap — smoke-8f77b261cf434c2a8a7795afe9786eea (152×152).
В обоих 4 игрока / 2 команды / 574 потери. Browser screenshot отдельно проверяет
реальный рельеф с явно синтетическими позициями; 6 browser-host checks PASS.
Исходный scripts/check.ps1 PASS: 673 Python / 130 Node, 2 прежних warnings;
project baseline exact (project-only gate не проверяет внешние skills).
Дополнительно exact local MPQ extraction MapInfo/Minimap PASS для пяти известных
архивов Fields of Death CE / Sentinel CE: unconfirmed-map-minimaps.json в test-data.
Это проверка чтения архивов, не подтверждение соответствия editor exports.

После обновления один раз заново подготовить выбранный реплей: parser cache v3
добавляет map_sha256. Следующая подготовка предпочитает появившийся editor export;
новая presentation обновляет клиентский фон даже при прежнем facts ID.
Архив, отсутствующий в локальном SC2 cache и portable bank, автоматически получить
нельзя: сетевое скачивание не реализовано. Не заявлять проверку всех 513 архивов.

## Реальная причина отказа из EXE ·27.10.2026

Итог: optimized build + stage в прежнюю папку `02_application/release/compose-replay-fix-preview`
PASS. Настоящий EXE на пользовательском Rhoskallian LE дважды прошёл
WebView→Tauri→resource-root worker→Runtime→SQLite→publicfacts:4игрока,2команды,
574потери,8255lifecycle,1101movement; второй запуск initialStatus=ready. SHA
исходника до/после совпал. Report:
`02_application/.compose-test-data/smoke-646e8acdc973455393606785fcfabc15/report.json`.
68Rust/361TS, typecheck/fmt/Clippy PASS; дополнительный test редактирования обычных
Disk/UNC путей из verbatim root PASS. Исходный check.ps1:673Python/130Node PASS,
2прежних warnings. Рабочий профиль/SC2/OBS не изменялись. Source review без
блокирующих замечаний; единственный P3 redaction исправлен и проверен.

decode_failed воспроизведён до запуска parser: Tauri resource_dir использует
канонический Windows путь `\\?\D:\…`, Node26.1.0 при таком main-module argument
падает с EISDIR/lstat D:. Старый check_postmatch передавал обычный путь, поэтому
не покрывал фактический способ запуска GUI. Предыдущие проверки файла не были
доказательством исправления ошибки собранного приложения.

ReplayRunner теперь преобразует только аргумент entrypoint из VerbatimDisk/UNC
в обычный абсолютный путь. Rust-пути executable/исходника и проверки чтения не
меняются. Regression test реально запускает Node с canonicalized helper в папке
с пробелом/кириллицей; отдельный тест сохраняет UNC и не переписывает Device.

Добавлен opt-in `smoke-compose.ps1 -PostmatchReplay`: полный WebView→Tauri→worker
из resource_dir→Runtime→SQLite→publicfacts,2запуска. По умолчанию только synthetic;
унаследованный replay-env очищается. Реальный путь передаётся только native через
явный параметр, в отчёте только счётчики/хеш-проверка; мониторинг/сеть выключены.

Сравнение со старым Python проведено: полного паритета пока нет. Старый s2protocol
выбирает точную схему, новый sc2readerjs допускает alias/latest fallback; отсутствуют
старые details/initData backup fallback и полная очистка roster names/небоевых slots.
Это отдельные известные расхождения, не причина Node EISDIR. Экспериментальный
экспорт схем не интегрирован и удалён; Python runtime не добавлялся.

## Защита ручного анализа и диагностика ошибок ·26.10.2026

По предоставленному пользователем Rhoskallian LE.SC2Replay выполнен read-only
прогон: bundled worker → Rust projection → изолированный Runtime → временная
SQLite → public facts. PASS:4игрока,2команды,574потери,8255lifecycle и1101movement.
SHA256 до/после совпал. Проверены dev и staged worker. Пользовательский профиль,
SC2/OBS не изменялись; сырой payload не добавлен в фикстуры/документацию.
Изолированно исходную ошибку именно этого файла воспроизвести не удалось.

В обычном runtime найдены и исправлены2гонки: неоднозначный watcher стирал ручной
анализ; окончание sync могло подменить его автоматическим разбором другого файла.
Теперь автоматический старт уступает любой текущей подготовке, а неоднозначность
отменяет только automatic. Проверки владельца атомарны под task lock; флаг
сохраняется в latest, старые latest трактуются как ручные. Новая игра/clearStats
по-прежнему снимают показ. Публикация результата/ошибки проверяет поколение.

Вместо общей «unavailable/unsupported» ошибки: фиксированные RU/EN error/errorCode
по этапам source/decode/projection/cache/storage, timeout и unsupported clock.
Наружу не выдаются пути или сырой текст worker/SQLite. Диагностический example
`src-tauri/examples/check_postmatch.rs` запускается только явной командой; он
не стартует мониторинг/сеть, пишет лишь временную SQLite и выводит счётчики.

65Rust/361TS, typecheck/rustfmt/Clippy PASS. Optimized build и отдельный stage
`02_application/release/compose-replay-fix-preview` PASS. Двухпроходный native
WebView2/IPC/SQLite/HTTP/restart smoke PASS:
`02_application/.compose-test-data/smoke-435a39feb8d5424e8bf5e263188b9d7b/report.json`.
Та же read-only проверка пользовательского реплея с новым staged worker PASS.
Исходный check.ps1 повторно673Python/130Node PASS,2прежних warnings.
Рабочий экземпляр пользователя не закрывался/не перезаписывался.
Independent source review: блокирующих регрессий
или циклов блокировок не найдено. Проверки моделируют фоновые переходы; реальная
гонка GUI/live не воспроизводилась. Native CUA не даёт геометрию для кликов,
поэтому выбор через GUI на рабочем экземпляре повторно не засчитан.

## Командные матчи и FFA ·26.10.2026

Причина пустого выбора: ранее оверлей выбирал только сохранённые матчи из истории
одного соперника, чей runtime/archive ingestion ограничен1×1. Сам parser принимал
две команды, но командная игра обычно не попадала в эту историю. Live status8766
во время диагностики: empty/available=false (без чтения пользовательских реплеев).

Добавлен native «Выбрать реплей…» независимо от истории. Выбор запускает прежний
bounded разбор с SHA256 до/после, поколением, SQLite cache и read-only исходником;
отмена сохраняет текущий анализ. Путь не передаётся через renderer/HTTP. Прямой
анализ не создаёт соперников/матчей; latest matchId=null. Историю можно обновить.
ProcessNewReplay больше не привязывает реплей с >2игроками к случайной1×1записи.

Parser/native projection/все4renderers поддерживают2–32реальные команды и до32игроков:
командные составы группируются с сохранением владельцев, FFA не сводится к2сторонам.
Версия parser/hash v2-multiteam. Динамические заголовки, счётчики, столбцы/маркеры,
фонтан с отдельными полосами; при2командах прежняя траектория сохранена. Ready,
скрытый фазой игры, больше не называется «нет разобранного матча».

Фокус:1×1/2×2/3×3/4×4/FFA с современным Faster tracker реплеем >120сек.
Однокомандные co-op/arcade/динамические союзы не заявлены. Автоматическая привязка
по прежней истории остаётся1×1; командные/FFA открываются отдельной кнопкой.
Реальные реплеи/автопереход/OBS пока NOT RUN. Большому числу сторон нужна большая
рамка: столбцы переносятся по4, заголовок ограничен40vh с прокруткой.

361TS/60файлов,62Rust,6reviewNode, typecheck/Clippy PASS. Independent source review:
блокирующих замечаний нет; исправлены лимит подписи512 и попадание анимации в строку
своей команды. Browser synthetic4teamFFA: выбор→четыре вида, все4стороны/ресурсы,
без console errors. Это проверка syntheticfacts, не декодирования реального реплея.
Evidence: `02_application/.compose-test-data/visual-browser-1aa4bd2d-d2e5-4761-8c1d-c043dd4abaa5/ffa-four-views.png`.

Optimized build + отдельный stage `02_application/release/compose-multimode-preview`
PASS. Native WebView2/IPC/SQLite/HTTP двухпроходный smoke/restart PASS:
`02_application/.compose-test-data/smoke-49e2e4ff222045f8a475ba8f754d939f/report.json`.
Исходный check.ps1 повторно673Python/130Node PASS,2прежних warnings; rustfmt PASS.
Изолированное nativeокно запущено/AX прочитан; действие открытия системного диалога
через CUA не удалось (нет геометрии, затем обнаружен пользовательский ввод).
Этот ручной gate НЕ засчитан; только свой отмеченный тестовый экземпляр закрыт
после проверки PID/starttime/executable. Обычный runtime/SC2/OBS не тронуты.

## Четыре виджета меню · 26.10.2026

Реализованы фонтан потерь, карта сражений, армии/размены и герои матча в общем
HTML-источнике. Сетка32столбца×64строки: отдельные переключатели, drag/resize за
угол, стрелки/Shift+стрелки, числовые поля, пресет2×2, черновик/Apply. Старые
профили получают все4выключенными. Перекрытия разрешены, порядок слоёв фиксирован.

Один bounded TS tracker-parser в bundled Node читает события реплея; Rust проверяет
публикацию и хранит immutable facts в SQLite по SHA256/версии парсера. Один ID и
Unix startedAt для всех4видов; 20сек анимации, затем финальный кадр. Python-сервис
не требуется. 107существующих иконок включены локально с SHA256/атрибуцией.
Нет изображения карты — явно схема; отсутствующие цены/маршруты не выдумываются.
Ручная подготовка для сохранённого матча с replayPath; автоматическая только при
свежем меню, включённых применённых видах и однозначной связи с последней игрой.
Новая игра отменяет показ; clearStats удаляет также facts. Неоднозначность оставляет
ручной выбор. Исходные реплеи только читаются.

Native optimized build PASS. Обычный preview EXE занят; пользовательский процесс
не завершался. Новая сборка отдельно:
`02_application/release/compose-menu-postmatch-preview/SC2 Adjutant Compose.exe`.
Native WebView2/IPC/SQLite/HTTP smoke два запуска PASS: layout/Apply/CAS/restart,
empty analysis без фиктивного реплея, неизвестный матч отклонён, HTTP/статические
assets и закрытие собственного listener, исходные CSV неизменны. Evidence:
`02_application/.compose-test-data/smoke-5bd760b099884d85a61386fc1cf28a00/report.json`.
Новый NSIS installer на этом этапе не собирался.

Gates:352TS/59файлов,59Rust, typecheck/rustfmt/Clippy-Dwarnings,5reviewNode PASS.
Browser synthetic PASS: все4, drag, resize, клавиатура, пресет, Apply, общий источник;
ошибок консоли не обнаружено. Evidence:
`02_application/.compose-test-data/visual-browser-6330c07b-679b-40c8-bb21-2b47aa5bec42/menu-four-widgets.png`.
Исходный check.ps1:673Python/130Node PASS, прежние2warnings.
Реальные реплей/SC2/OBS ещё НЕ проверены. Tracker-clock ограничен современными
scaled Faster реплеями >120сек; неподдержанные данные дают ошибку. Полный паритет
анализа и автоматический переход требуют отдельной приёмки.

## Подготовка визуального прогона · 26.10.2026

Добавлены `review:browser`, `review:compose` и каталог57сценариев
[VISUAL-REVIEW](VISUAL-REVIEW.md). Браузерный пульт управляет кадрами/карточкой,
ошибками связи/данных/сохранения и тестовым выбором картинок. Он показывает
собранные реальные страницы с явно обозначенной имитацией данных и IPC;
результаты вводятся проверяющим, сохраняются вместе с метаданными сборки и
журналом действий. Сам стенд не доказывает native, SQLite или интеграцию SC2/OBS.

Native launcher создаёт отдельный отмеченный профиль, синтетические CSV/JSON,
широкую/вертикальную PNG, JPEG и неправильную картинку. Приложение проверяет
маркер до открытия хранилища, не подключает single-instance к рабочему окну,
отключает сеть и autostart. Внешние источники выключены даже при смене настроек;
реплеи закреплены за fixtures/replays, внешние пути и их смена отклоняются.
PID/start time/EXE SHA256 записываются в review-process.json; повторный запуск
занятого профиля отклоняется. Окно запускается интерактивно для ручной проверки.

Фактические gates:330Vitest +4Nodeпроверки границы стенда PASS;53Rusttests,
Clippy-Dwarnings, typecheck и fmt PASS. Исходный scripts/check.ps1 повторно
PASS673Python/130Node, baseline exact, прежние2dependency warnings.
Независимый review нашёл fallback на личную папку реплеев; исправлен и отдельно
проверен. Release EXE/preview пересобраны. Native smoke с двумя запусками PASS:
`.compose-test-data/smoke-111008d3bd0146889d6625988442a97c/report.json`.

Пульт, переключение загрузки, тестовый PNG и предпросмотр черновика проверены
в браузере. Настоящее окно отмеченного профиля запущено, WebView2/его содержимое
подтверждены через accessibility. Захват снимка native-окна в текущем инструменте
завершился timeout; на этом проходе file picker/трей визуально не подтверждались.
Все57строк ручной приёмки остаются NOT RUN, до фактического выполнения и evidence.
Git, рабочие данные, OBS-сцены и запущенный SC2 не изменялись.

## Настройки четырёх кадров · 25.10.2026

В Compose перенесены кадры menu/loading/game/pause: отдельное включение,
выбор PNG/JPEG/GIF через диалог Windows, возврат стандартного вида, предпросмотр,
сохранение черновика и явное «Применить в OBS». Копии изображений принадлежат
профилю; оригиналы read-only. SQLite хранит применённую версию отдельно от
черновика; CAS отклоняет устаревшую запись. Настройки карточки независимы.

Реализованы декодирование/лимиты, GIF-постер и reduced-motion, запрет APNG,
квоты128изображений/512МиБ, ограниченный HTTP-доступ по зарегистрированным UUID.
Публичный снимок не содержит имён/путей изображений. Общая saveSettings не
обходит проверку черновиков. Встроены прежние BRAT_OK GIF/постер и Terran HUD;
меню по умолчанию прозрачное, свои снимки из data автоматически не переносились.

Независимый generation-owned опрос SC2 /game+/ui переключает оформление и
определяет паузу по свежему таймеру; enrichment соперника не блокирует его.
Неизвестное состояние прозрачно; установленная загрузочная подложка удерживается
до известного перехода/отключения. Перезапуск мониторинга не использует старый
образец. Дополнительный читатель ограничен loopback/таймаутом/64КиБ; отключён
в изолированном smoke. Подробные ограничения — в DEVELOPMENT.

TypeScript typecheck и330тестов в56файлах PASS. Rust50/50, Clippy-Dwarnings и
rustfmt PASS. Независимый source review выявил APNG, зависимость от
ошибки enrichment и несовпадения UI/лимитов; исправлены. Браузерная проверка
синтетического UI:4кадра, встроенный GIF/HUD/пауза, выключение кадра, черновик/Apply,
отмена тестового выбора PASS. Это не проверка выбора файла в настоящем диалоге
Windows или живого SC2/OBS. Исходный scripts/check.ps1 PASS673Python/130Node,
Ruff/format, проектная часть baseline exact; прежние2dependency warnings.

Собранный release preview: native WebView2→IPC→SQLite PASS в двух запусках,
включая раздельные draft/Apply, отклонение старой revision, сохранение оформления
после перезапуска, HTTP/JS после команды закрытия окна, освобождение порта,
кириллицу и неизменные CSV. Evidence:
`.compose-test-data/smoke-91f7754b50504158981073272d904046/report.json`.
Реальные SC2, OBS и пользовательские профили не использовались.

Обновлённые release EXE, preview и NSIS x64 собраны. Setup177.78МиБ:
встроенный GIF57.3МБ входит в ресурсы предпросмотра и отдельной OBS-страницы,
поэтому этот этап увеличил дистрибутив. Установка на чистой Windows, реальные
клики диалога выбора файла/трэй-меню и замеры производительности ещё не проверены.
Все изменения локальные, без Git/коммитов/push/публикации в этом продолжении.

Профили, геометрия/калибровка, ручная cover, полный каталог/переходы виджетов и
четыре постматчевых вида ещё не перенесены. Полный M1/M2 и Rust migration не DONE.

## HTML-источник OBS · 25.10.2026

Первый виджет перенесён в самостоятельную HTML/React-страницу с прозрачным
полотном: карточка соперника, положение, размер1920×1080/2560×1440, RU/EN.
В настройках Tauri появился раздел «Оверлей OBS» с адресом, копированием,
предпросмотром и немедленным сохранением в SQLite. Прежняя карточка на экране
игрока включается отдельно. Закрытие главного окна оставляет движок в трее;
сворачивание обычное, завершение через «Выход» выключает источник.

Axum слушает только loopback (по умолчанию8766), отдельно от исходного проекта8765.
HTTP только GET/HEAD: статические ресурсы, health и ограниченный снимок виджета;
команд управления, заметок, путей и BattleTag в нём нет. Проверяются Host/Origin,
границы ресурсов, текущий1v1 и свежесть данных; неоднозначный/устаревший матч
скрывается. Занятый порт даёт явную ошибку без остановки чужой службы.

Браузерная проверка сборки на синтетическом стенде: карточка, длинное имя,
нижняя позиция и пустой неактивный источник PASS. Настройки проверены визуально;
исправлено сжатие панелей/наложение пояснений. Это проверка HTML с тестовыми
данными, а не реального SC2 или OBS. Независимый source review: P1 не найдено,
замечание о RU/EN исправлено. TypeScript320/320 в55файлах PASS.

Rust desktop39/39, Clippy-Dwarnings и rustfmt PASS. Обновлённые release EXE,
preview и NSIS x64 собраны; setup68.52MiB (на рабочую Windows не устанавливался).
Реальный native WebView2 smoke PASS в двух запусках: HTTP health/HTML/JS,
ограниченный DTO, источник доступен после команды закрытия окна, отдельные
настройки OBS и заметка переживают перезапуск, кириллица совпадает с UTF-8
фикстурой, оригинальные CSV имеют прежние хеши. После каждого выхода TCP-порт
возвращает ConnectionRefused. SC2 и внешние источники в smoke отключены.
Evidence: `.compose-test-data/smoke-2092340ab0494962bc6d67559b1c9d30/report.json`.
Smoke не проверяет реальные клики меню трея, OBS или активный матч SC2.
Исходный StarCraft Adjutant scripts/check.ps1 повторно PASS673Python/130Node,
Ruff/format и проектная часть baseline exact; прежние2dependency warnings.

Полные единые раскладки, переходы виджетов и4постматчевых вида ещё не перенесены.
Эта HTML-карточка не означает завершение M1/M2 или замены Node-адаптера на Rust.

## Исправление dev watcher · 25.10.2026

По пользовательскому логу Vite наблюдал src-tauri/target и падал EBUSY при
линковке EXE. В vite.config.ts исключён весь src-tauri (Rust наблюдает Tauri),
а также ресурсы сборки, release и тестовые данные. strictPort=true сохраняет
совпадение5173 с Tauri devUrl, clearScreen=false сохраняет сообщения Rust.
TypeScript PASS; реальный Vite watcher PASS на свободном временном порту:
каталог Rust исключён, React наблюдается, HTML и модуль приложения HTTP200.
Работающие пользовательские процессы не останавливались; Git не вызывался.

25.10.2026. Реализация первого этапа начата. Полная миграция не завершена.

- Рабочее дерево до начала чистое. Ветка compose от side-logic-integration, 9187ff4.
- Исходный Electron и его release workflow сохраняются до доказательства паритета.
- Текущая машина: Node v26.1.0 / npm 11.14.1, MSVC Build Tools обнаружены.
- Установлены системные пользовательские rustup/Rust1.99.1, Cargo, rustfmt и Clippy.
  Сборочный wrapper предпочитает их; .compose-tools остаётся fallback/cache.
- Уже установлены Node26.1.0/npm11.14.1, MSVC Build Tools, WebView2 155.0.4283.62,
  FFmpeg/FFprobe8.1.1. Docker24.0.2/Compose2.19.1 доступны, Docker engine остановлен.
  Его служба, WSL, существующие контейнеры не менялись.
- Решение пользователя: встроенная SQLite; Docker только для вспомогательных сервисов.
- Действующие пользовательские данные/SC2/OBS не открывались для записи.
- Native Store/SQLite import, lifecycle SC2/watcher, scoped Tauri IPC, прежние
  main/overlay окна, compact/drag и локальный voice-resource protocol реализованы.
- Сложные identity/enrichment/replay usecases пока выполняются существующим TS
  адаптером в ограниченном Node-процессе. Runtime включает Node26.1.0 и исходный
  LICENSE с закреплённым SHA. Полное Rust-ядро НЕ заявлено.

## Предыдущий контрольный этап (до HTML-источника)

- TypeScript typecheck PASS; Vitest314/314 в54файлах PASS.
- Cargo test с desktop feature32/32 PASS; rustfmt и Clippy-Dwarnings PASS.
- Старый Electron build PASS; его команды/release pipeline не заменены.
- Native release EXE и NSIS x64 setup собраны. Последний setup около59.92MiB:
  `02_application/src-tauri/target/release/bundle/nsis/SC2 Adjutant Compose_1.1.11_x64-setup.exe`.
- Preview: `02_application/release/compose-preview/SC2 Adjutant Compose.exe`.
- Реальный WebView2 smoke на синтетической копии CSV/JSON PASS: импорт, чтение,
  запись заметки по расе, избранное, детали/честная ошибка отсутствующего реплея,
  нормализация позиции, compact1469×860→400×220→1469×860, import локального ONNX.mjs,
  запрет file:// external URL. Второй запуск подтвердил сохранение заметки в SQLite.
  Контрольные суммы оригинальных CSV после двух запусков совпали.
  SC2 autostart/HTTP в этом smoke отключены в runtime, внешние источники off.
  Evidence: `.compose-test-data/smoke-3697fd9f61d54b7b901b0260a4e31d18/report.json`.
- Собранный Node worker отдельно PASS: синтетическая регистрация/повтор без дублей,
  внешние источники выключены, пользовательские файлы не читаются.
- Independent source review: исправлены compact/drag/CSP/error propagation,
  persisted SC2Pulse cache/cooldown, восстановление координат и внешние ссылки.
- Исходный StarCraft Adjutant scripts/check.ps1 PASS673Python/130Node,
  Ruff/format и project baseline exact; прежние2dependency warnings.

## Что ещё НЕ подтверждено / НЕ завершено

- Полный паритет friend runtime: startup self-heal/все сложные identity-сценарии,
  качество/тайминги озвучки, реальные SC2/replay/SC2Pulse и пользовательская копия БД.
- Полная замена TS/Node адаптера на Rust и Rust-декодер нужных версий реплеев.
- Синтез голоса с моделью: моделей в исходной копии нет, не скачивались. Проверен
  импорт локального runtime модуля, а не готовая речь.
- Установка/обновление/удаление setup на чистой Windows и автономный portable-runtime.
  Сам NSIS setup собран, но не устанавливался на рабочую Windows пользователя.
- Автоматический импорт старого профиля/UI выбора данных. Пока проверка через
  SC2_ASSISTANT_DATA_DIR, указывающий на отдельную копию; оригиналы не перезаписываются.
- Замеры производительности и реальная визуальная проверка drag/click-through SC2.
- Четыре постматчевых вида и сетка меню реализованы; реальные реплеи/SC2/OBS TODO.
  Общий каталог/профили и миграции между экранами остаются следующим этапом.
  Шортсы PAUSED, новые обработка/интерфейс не добавлялись.
- Изменения локальные, без коммита/push/публикации. compose подтверждена локально.

Скоуп и приёмка: [SCOPE](SCOPE.md). Очередь: [BACKLOG](BACKLOG.md).
