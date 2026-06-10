# Android bugreport importer: dumpsys coverage

How the importer extracts timeline data from `dumpsys` service dumps inside
Android bugreports. Audited against an SDK 36 (Baklava) cuttlefish bugreport
and the SDK 31 crosshatch test bugreport (`test/data/bugreport-crosshatch-SPB5.zip`).

## Coverage layers

1. **Catch-all** (`dumpsys_eventlog_parser.cc`, registered for `*`): every
   dumpsys service is scanned for the three standard Android event-log
   idioms, with no per-service code:
   - `com.android.internal.util.StateMachine` records
     (`rec[N]: time=... what=...`)
   - `android.util.LocalLog` lines (`<timestamp> - <msg>`; modern ISO-'T'
     `LocalDateTime`, NetworkPolicyLogger's colon-millis variant, and the
     legacy `MM-DD` form)
   - `com.android.server.utils.EventLogger` blocks (`Events log: <tag>`)
   - bare timestamped event lines (`MM-DD HH:MM:SS.mmm <msg>` or
     `YYYY-MM-DD HH:MM:SS.mmm <msg>` at line start; millisecond resolution
     required), e.g. netd's event log and appops' COMMIT_UID_STATE log
   The same idioms also run over the `APP SERVICES *` / `APP PROVIDERS *`
   dumpstate sections, with events attributed per app-service component
   ("SERVICE com.foo/.Bar" headers) - e.g. SystemUI and TelephonyDebugService
   histories.
   Services covered this way in current bugreports include: netpolicy,
   phone, telephony.registry, tethering, isub, connectivity, carrier_config,
   wifi, wifip2p, isms, netstats, network_stack, telecom, bluetooth (recs),
   servicediscovery, wifiscanner, vpn_management, soundtrigger, location,
   and any future service using these idioms.

2. **Bespoke parsers** (registered in `bugreport_parser_registry.cc`,
   SDK-gated; one file per service):

   | Service | Data parsed | Track(s) |
   |---|---|---|
   | activity | historical broadcasts (legacy split queues + modern unified) | Broadcasts |
   | activity | process start times, exit info (crash/ANR -> App errors), recent tasks, activity launches | Process starts/exits, Recent tasks, Activity launches |
   | activity | running service createTime, provider connection ages | Service starts, Provider connections |
   | alarm | TIME_TICK history, wakeup deliveries, removal history | Alarms |
   | app_hibernation | per-package lastUnhibernated times | App hibernation |
   | appops | per-op Access/Reject/Running entries | AppOps |
   | audio | AudioService EventLogger blocks (all categories) | Audio |
   | bluetooth_manager | enable log, scan mode changes, GATT/native shim logs | Bluetooth |
   | connmetrics | ConnectivityMetricsEvent / aggregate stats lines | Network metrics |
   | dbinfo | per-database recent SQL operations (with durations) | Database ops |
   | display | brightness event ring buffers | Display |
   | dropbox | entry list (crashes, strictmode, watchdog...) | Dropbox |
   | input | InputDispatcher key/motion event queues (elapsed-anchored) | Input events |
   | input_method | ImeTracker / StartInput / SoftInputShowHide history | IME |
   | jobscheduler | job history START/STOP paired into slices | Job history |
   | media.metrics | metrics item dumps (audio/codec/extractor/drm) | Media metrics |
   | notification | posted/enqueued notification records | Notifications |
   | package | per-package first install / update times | Package installs/updates |
   | power | Notifier wake lock log (ACQ/REL slices), held suspend blockers | Power: wake locks / suspend blockers |
   | sensorservice | recent sensor events + registrations | Sensors |
   | settings | per-namespace historical setting mutations | Settings |
   | thread_network / time_detector / time_zone_detector / usb / uwb | misc debug-log / timestamped-state entries | <service> events |
   | usagestats | daily event log; activity resume/pause paired | App usage, Usage events |

   Dumpstate (non-dumpsys) sections: SYSTEM/EVENT/RADIO LOG (logcat),
   KERNEL LOG (via deduplicating reader), CHECKIN BATTERYSTATS
   (battery_stats.* tracks), VM TRACES (Stack dumps).

   Other files in the bugreport zip: persistent logcat
   (`FS/data/misc/logd/*`, deduplicated against the dumpstate logs) is
   imported as android_logs; every other text file (FS/proc/*, linkerconfig,
   dumpstate_log.txt, board dumps, ...) is ingested into
   `android_dumpstate` with section = file path so it is browsable in the
   UI; `FS/data/anr/*` and tombstone files additionally run through the
   stack-dump parser. Known binary artifacts are skipped: `proto/*.proto`
   (binary `dumpsys --proto` snapshots; candidate follow-up: feed the
   SurfaceFlinger/WindowManager ones through the winscope proto importers),
   `visible_windows.zip`, images and `*.gz`.

3. **Raw + structured browsing**: every line of every section lands in the
   `android_dumpstate` table; the Bugreport Explorer UI plugin
   (`ui/src/plugins/com.android.BugreportExplorer`) renders any service
   through a grammar-based entity viewer (hierarchy pane + properties pane,
   in the SurfaceFlinger-viewer idiom). The parser
   (`renderers/entity_tree.ts`) implements a formally derived grammar of the
   Android dump-printer line classes (22 classes, transcribed from the AOSP
   printer sources - IndentingPrintWriter/printPair, DualDumpOutputStream,
   LocalLog/EventLogger/StateMachine, record-header conventions) as an
   ordered rule table plus composable tree passes (indent-unit detection,
   continuation joining, brace balancing, table/event grouping). Measured on
   the SDK 36 corpus: 98.4% of the 120k dumpsys lines classify as
   non-prose, zero conservation failures (every input line is attributable
   to an entity, property, text, table or event). Dedicated table renderers
   cover SYSTEM PROPERTIES, dropbox, meminfo, cpuinfo, FILESYSTEMS & FREE
   SPACE, PSI, PROCRANK/LIBRANK and the dumpstate header.

## Time bases

All conversions live in `bugreport_time.{h,cc}` and per-parser helpers:
- wall-clock ISO (`2026-06-10 09:21:16[.123]`), local timezone; tz offset
  discovered from the alarm dump and applied by the emitter
- `TimeUtils.formatDuration` relative offsets (`-19m40s688ms`), anchored at
  the dumpstate start time
- `MM-DD` / time-of-day formats: year/date derived from dumpstate start
  (with Dec/Jan and midnight wraparound rules)
- elapsedRealtime values: converted via the exact anchor parsed from the
  alarm dump's `nowRTC=`/`nowELAPSED=` line
  (`BugreportFormat::ElapsedToWallMs`, `BugreportTimelineEmitter::EmitAtElapsed`)
- UTC epoch-ms / ISO-'Z' values: shifted by the timezone offset

## Known unanchorable data (deliberately not parsed)

Fields whose only time base is uptime/elapsed **printed as "ago" durations
with no anchor at dump time**, or future-scheduled items: power
mLastWakeTime/mLastSleepTime, pending alarms, job nextRestartTime, LRU
"start-info" monotonic times, UID state bg durations, window/display
elapsed-only fields. Where a wall-clock or anchorable equivalent exists it
is parsed instead.

## Updating for format drift

When a service's dump format changes in Android release N: cap the existing
registry entry at `max_sdk = N - 1` and register the new variant with
`min_sdk = N` (see `BugreportParserRegistration`). Timestamp-format changes
usually only need a fix in `bugreport_time.cc` or the catch-all.
