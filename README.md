# aila-neteaseMusic-plugin
## 安装插件

#### 1. 克隆仓库

```
git clone https://github.com/zqyaila/aila-neteaseMusic-plugin.git ./plugins/aila-neteaseMusic-plugin
```

> [!NOTE]
> 如果你的网络环境较差，无法连接到 Github，可以使用 [GitHub Proxy](https://ghproxy.link/) 提供的文件代理加速下载服务
>

#### 2.配置token前往网页网易云登录，按f12中的网络，随便找一个请求，找到元素中的cookie，将MUSIC_U=以及后面的值复制到config/netease_cookie.txt
/**
 * 网易云音乐解析与搜索插件
 * 适配 TRSS-Yunzai + NapCat (OneBot v11)
 *
 * 插件位置：plugins/aila-plugin/apps/netease-music.js
 * cookie 配置：plugins/aila-plugin/config/netease_cookie.txt
 * 插件配置：plugins/aila-plugin/config/netease_config.json（自动生成）
 *
 * 指令：
 *   #点歌 <关键词>          搜索并选歌，回复序号发送
 *   #解析 <ID/链接>         解析单曲
 *   #歌词 <ID/链接>         获取歌词
 *   #网易音质 <档位>         切换音质（master/hires/lossless/exhigh/standard）
 *   #网易发送 <方式>         切换发送方式（file / record）
 *   #网易状态               查看当前配置
 *   自动识别：直接发送分享文本/短链接/小程序卡片即触发解析
 *
 * 发送方式说明：
 *   file   → 群文件，按配置音质发送原始文件
 *   record → 语音消息，强制使用 standard(128k mp3) 避免转码失败
 */


根据 https://github.com/Suxiaoqinx/Netease_url/ 迭代的TRSS插件
