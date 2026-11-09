# 旧版 Office 测试文件

这些文件来自 Apache POI 的公开测试集，遵循本目录的 `LICENSE` 和 `NOTICE`。
源版本固定为 `df7d70faa13003593f272259c7fe8ed787f507df`，不包含用户文件。

上游：https://github.com/apache/poi/tree/df7d70faa13003593f272259c7fe8ed787f507df/test-data

| 本地文件 | 上游路径 | 用途 |
| --- | --- | --- |
| simple.doc | document/simple.doc | Word 二进制正文 |
| simple.xls | spreadsheet/Simple.xls | Excel 二进制单元格 |
| simple.ppt | slideshow/basic_test_ppt_file.ppt | PowerPoint 二进制幻灯片 |
| encrypted.doc | document/PasswordProtected.doc | 加密文件拒绝 |
| encrypted.xls | spreadsheet/password.xls | 加密文件拒绝 |
| encrypted.ppt | slideshow/Password_Protected-hello.ppt | 加密文件拒绝 |
| macros.xls | spreadsheet/SimpleMacro.xls | 宏文件拒绝 |
| macros.ppt | slideshow/SimpleMacro.ppt | 宏文件拒绝 |

这些二进制文件仅用于测试，不随应用分发。
