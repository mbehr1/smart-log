# Change Log

All notable changes to the "smart-log" extension will be documented in this file.

<!-- Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file. -->

## [1.4.0]
- Moved view into "Logs" activity bar so that the view appear in same bar as dlt-logs.

## 1.3.0]

- Auto time-sync (sending time events on selection of a line) can be turned on/off now with the sync button in the editor title. Default off.
- If turned off the time can be send manually by selecting the "send selected time" context button.
- Detected time-sync events can be resend by using "alt/option" on the sync button in the editor title.

## [1.2.2]

- Time sync loop iterator fix.

## [1.2.1]

- Send time sync values in lower case letters.
- Improve UI responsiveness by using some asyncs and showing progress.

## [1.2.0]

- First part of auto time-sync feature (introduction of timeSyncId, timeSyncPrio to events). Does broadcast the events already but does not adjust time yet (just prints on console min/max/avg adjustment values).

## [1.1.0]

- Post time updates max. every 500ms.

## [1.0.0]

- improved time regex / parsing
- added example for "common log format" (http logs)
- post time updates only on valid times

## [0.9.1]
- Added telemetry using vscode-extension-telemetry with events: 'activate' and 'open file' (measurements number of fileConfigs).
The telemetry is following the user setting: telemetry.enableTelemetry.

## [0.9.0]

- Initial release with lots of console output to ease testing (thus version not 1.0.0 :-)