# Smart-Log README

[![Version](https://vsmarketplacebadge.apphb.com/version/mbehr1.smart-log.svg)](https://marketplace.visualstudio.com/items?itemName=mbehr1.smart-log)

This Visual Studio Code(tm) extension adds **analysis** and **visualization** features for log files and should ease debugging especially of complex systems where multiple log files need to be considered at the same time.

**Note:** It works well with [![Version](https://vsmarketplacebadge.apphb.com/version/mbehr1.vsc-lfs.svg)](https://marketplace.visualstudio.com/items?itemName=mbehr1.vsc-lfs) to handle large log files (few hundred MBs).

**Note:** The **time-sync** feature works well with [![Version](https://vsmarketplacebadge.apphb.com/version/mbehr1.dlt-logs.svg)](https://marketplace.visualstudio.com/items?itemName=mbehr1.dlt-logs) for DLT (diagnostic log and trace) files.


## Features

- Configurable **event tree-view** (todo picture):
  - Helps quickly to understand the structure or to highlight events (errors/warnings,...).
  - Quickly jump to the event by selecting the item in the tree-view.
- Configurable **decorations** (todo picture).
- **Time sync** feature (todo movie...):
  - Detects time for each line.
  - An offset for the full file can be set via context menu item *adjust time...*.
  - Posts events of the selected time to other documents/plugins. (See ... <todo>).
  - Allows to "synchronize" this time with other visible documents from all plugins that support "onDidChangeSelectedTime" events. 
- Allows configuration of **multiple file types** (see settings smart-log.fileConfigs).

<!-- 
For example if there is an image subfolder under your extension project workspace:

\!\[feature X\]\(images/feature-x.png\)

> Tip: Many popular extensions utilize animations. This is an excellent way to show off your extension! We recommend short, focused animations that are easy to follow.
-->

## Requirements

To open large log files please consider installing "vsc-lfs" extension.
## Extension Settings

This extension contributes the following settings:

* `smart-log.timeRegex`: Regular expression (regex) to identify the time of a log line.
* `smart-log.decorations`: Definition of the decoration types supported for events.
* `smart-log.fileConfigs`: Definition of the configuration per file type.

(todo add example configs)

## Known Issues

(Little testing done yet...)

## Contributions

Any and all test, code or feedback contributions are welcome.
Open an [issue](https://github.com/mbehr1/smart-log/issues) or create a pull request to make this extension work better for all.

[![Donations](https://www.paypalobjects.com/en_US/DK/i/btn/btn_donateCC_LG.gif)](https://www.paypal.com/cgi-bin/webscr?cmd=_s-xclick&hosted_button_id=2ZNMJP5P43QQN&source=url) are welcome! (Contact me for commercial use or different [license](https://creativecommons.org/licenses/by-nc-sa/4.0/legalcode)).

## Planned features

* automatic timezone detection
* improved time regex / parsing
* time sync auto-synchronization
* change "smart-log" file type automatically to sub-types
* add event icon support in tree view
* add event support to modify parent title
* add decoration for time-sync

## Release Notes

See [Changelog](./CHANGELOG.md)

<!-- 
**Note:** You can author your README using Visual Studio Code.  Here are some useful editor keyboard shortcuts:

* Split the editor (`Cmd+\` on macOS or `Ctrl+\` on Windows and Linux)
* Toggle preview (`Shift+CMD+V` on macOS or `Shift+Ctrl+V` on Windows and Linux)
* Press `Ctrl+Space` (Windows, Linux) or `Cmd+Space` (macOS) to see a list of Markdown snippets

### For more information

* [Visual Studio Code's Markdown Support](http://code.visualstudio.com/docs/languages/markdown)
* [Markdown Syntax Reference](https://help.github.com/articles/markdown-basics/)
-->
