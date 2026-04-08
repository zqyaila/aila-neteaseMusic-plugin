import plugin from '../../../lib/plugins/plugin.js'
import fetch from 'node-fetch'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { createWriteStream } from 'fs'
import { fileURLToPath } from 'url'
import os from 'os'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// ─────────────────────────────────────────────────────────────
// 常量
// ─────────────────────────────────────────────────────────────
const AES_KEY = Buffer.from('e82ckenh8dichen8')
const UA      = 'Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Safari/537.36 Chrome/91.0.4472.164 NeteaseMusicDesktop/2.10.2.200154'
const REFERER = 'https://music.163.com/'

const API = {
  SONG_URL:    'https://interface3.music.163.com/eapi/song/enhance/player/url/v1',
  SONG_DETAIL: 'https://interface3.music.163.com/api/v3/song/detail',
  SEARCH:      'https://music.163.com/api/cloudsearch/pc',
  LYRIC:       'https://interface3.music.163.com/api/song/lyric',
}

const DEFAULT_COOKIES = { os: 'pc', appver: '', osver: '', deviceId: 'pyncm!' }

// 音质优先级顺序（从高到低），降级时按此顺序
const QUALITY_ORDER = ['jymaster', 'hires', 'lossless', 'exhigh', 'standard']

const QUALITY_NAMES = {
  standard: '标准 128k',
  exhigh:   '极高 320k',
  lossless: '无损 FLAC',
  hires:    'Hi-Res',
  jyeffect: '高清环绕声',
  sky:      '沉浸环绕声',
  jymaster: '超清母带',
}

// 路径
const COOKIE_FILE = path.join(__dirname, '../config/netease_cookie.txt')
const CONFIG_FILE = path.join(__dirname, '../config/netease_config.json')

// 临时目录使用绝对路径避免 os.tmpdir() 异常
const TMP_DIR = '/tmp/yunzai_netease'

// 选歌会话
const pendingSessions = new Map()
const SESSION_TIMEOUT = 30_000

// ─────────────────────────────────────────────────────────────
// 配置管理
// ─────────────────────────────────────────────────────────────
function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'))
    }
  } catch {}
  return {}
}

function saveConfig(cfg) {
  try {
    fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true })
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf-8')
  } catch (e) {
    logger.error(`[网易云] 保存配置失败: ${e.message}`)
  }
}

function getPreferredQuality() {
  return loadConfig().quality || 'lossless'
}

function getSendMode() {
  return loadConfig().sendMode || 'file'
}

// ─────────────────────────────────────────────────────────────
// 加密工具
// ─────────────────────────────────────────────────────────────
function encryptParams(url, payload) {
  const urlPath = new URL(url).pathname.replace('/eapi/', '/api/')
  const bodyStr = JSON.stringify(payload)
  const digest  = crypto.createHash('md5')
    .update(`nobody${urlPath}use${bodyStr}md5forencrypt`)
    .digest('hex')
  const plain   = `${urlPath}-36cd479b6b5-${bodyStr}-36cd479b6b5-${digest}`
  const cipher  = crypto.createCipheriv('aes-128-ecb', AES_KEY, null)
  cipher.setAutoPadding(true)
  return Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]).toString('hex')
}

// ─────────────────────────────────────────────────────────────
// Cookie 管理
// ─────────────────────────────────────────────────────────────
function readCookie() {
  try {
    return fs.existsSync(COOKIE_FILE)
      ? fs.readFileSync(COOKIE_FILE, 'utf-8').trim()
      : ''
  } catch { return '' }
}

function parseCookieString(str) {
  if (!str) return {}
  return Object.fromEntries(
    str.split(';')
      .map(s => s.trim().split('='))
      .filter(([k]) => k)
      .map(([k, ...v]) => [k.trim(), v.join('=').trim()])
  )
}

function getCookies() {
  return { ...DEFAULT_COOKIES, ...parseCookieString(readCookie()) }
}

function buildCookieHeader(cookies) {
  return Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ')
}

// ─────────────────────────────────────────────────────────────
// HTTP 工具
// ─────────────────────────────────────────────────────────────
async function eapiPost(url, payload) {
  const params = encryptParams(url, {
    ...payload,
    header: JSON.stringify({
      os: 'pc', appver: '', osver: '', deviceId: 'pyncm!',
      requestId: String(Math.floor(Math.random() * 10_000_000 + 20_000_000)),
    }),
  })
  const res = await fetch(url, {
    method:  'POST',
    headers: {
      'User-Agent':   UA,
      'Referer':      REFERER,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Cookie':       buildCookieHeader(getCookies()),
    },
    body:    new URLSearchParams({ params }),
    timeout: 20_000,
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

async function plainPost(url, data, withCookie = false) {
  const headers = {
    'User-Agent':   UA,
    'Referer':      REFERER,
    'Content-Type': 'application/x-www-form-urlencoded',
  }
  if (withCookie) headers['Cookie'] = buildCookieHeader(getCookies())
  const res = await fetch(url, {
    method:  'POST',
    headers,
    body:    new URLSearchParams(data),
    timeout: 15_000,
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

// ─────────────────────────────────────────────────────────────
// 封面图 URL
// ─────────────────────────────────────────────────────────────
function getPicUrl(picId, size = 300) {
  if (!picId) return ''
  const magic = [...'3go8&$8*3*3h0k(2)2']
  const xored = [...String(picId)]
    .map((c, i) => String.fromCharCode(
      c.charCodeAt(0) ^ magic[i % magic.length].charCodeAt(0)
    ))
    .join('')
  const enc = crypto.createHash('md5').update(xored, 'binary').digest('base64')
    .replace(/\//g, '_').replace(/\+/g, '-')
  return `https://p3.music.126.net/${enc}/${picId}.jpg?param=${size}y${size}`
}

// ─────────────────────────────────────────────────────────────
// 短链接展开
// ─────────────────────────────────────────────────────────────
async function expandShortUrl(shortUrl) {
  try {
    const res = await fetch(shortUrl, {
      method:   'GET',
      redirect: 'manual',
      timeout:  10_000,
      headers:  { 'User-Agent': UA },
    })
    return res.headers.get('location') || shortUrl
  } catch {
    return shortUrl
  }
}

// ─────────────────────────────────────────────────────────────
// ID 提取
// ─────────────────────────────────────────────────────────────
async function extractSongId(input) {
  input = String(input).trim()

  if (/^\d{5,12}$/.test(input)) return { id: input }

  const stdMatch = input.match(/music\.163\.com\S*[?&]id=(\d+)/)
  if (stdMatch) return { id: stdMatch[1] }

  const shortMatch = input.match(/https?:\/\/163cn\.tv\/\S+/)
  if (shortMatch) {
    const expanded = await expandShortUrl(shortMatch[0].replace(/[）)。，,\s]+$/, ''))
    const m = expanded.match(/[?&]id=(\d+)/)
    if (m) return { id: m[1] }
  }

  return null
}

async function extractIdFromEvent(e) {
  if (e.msg) {
    const result = await extractSongId(e.msg)
    if (result) return result
  }

  const jsonSeg = e.message?.find(seg => seg.type === 'json')
  if (jsonSeg) {
    try {
      const raw  = typeof jsonSeg.data === 'string' ? jsonSeg.data : (jsonSeg.data?.data || '')
      const data = JSON.parse(raw)
      const jumpUrl =
        data?.meta?.music?.jumpUrl     ||
        data?.meta?.detail_1?.qqdocurl ||
        data?.meta?.news?.jumpUrl      ||
        data?.jumpUrl                  ||
        ''
      if (jumpUrl) return extractSongId(jumpUrl)
    } catch {}
  }

  return null
}

// ─────────────────────────────────────────────────────────────
// 判断是否为网易云分享消息
// ─────────────────────────────────────────────────────────────
function isNeteaseShare(e) {
  const msg = e.msg || ''

  if (/163cn\.tv/.test(msg)) return true
  if (/music\.163\.com/.test(msg)) return true

  const jsonSeg = e.message?.find(seg => seg.type === 'json')
  if (jsonSeg) {
    try {
      const raw = typeof jsonSeg.data === 'string' ? jsonSeg.data : (jsonSeg.data?.data || '')
      if (raw.includes('163cn.tv') || raw.includes('music.163.com') || raw.includes('163.com')) {
        const data    = JSON.parse(raw)
        const appName = data?.appInfo?.appName || data?.app || ''
        if (/网易云|music/i.test(appName)) return true
        const jumpUrl =
          data?.meta?.music?.jumpUrl     ||
          data?.meta?.detail_1?.qqdocurl ||
          ''
        if (/163\.com/.test(jumpUrl)) return true
      }
    } catch {}
  }

  return false
}

// ─────────────────────────────────────────────────────────────
// 核心 API
// ─────────────────────────────────────────────────────────────
async function searchMusic(keywords, limit = 8) {
  const data = await plainPost(API.SEARCH, { s: keywords, type: 1, limit })
  if (data.code !== 200) throw new Error(data.message || '搜索失败')
  return (data.result?.songs || []).map(item => ({
    id:      item.id,
    name:    item.name,
    artists: item.ar?.map(a => a.name).join('/') || '未知',
    album:   item.al?.name || '未知专辑',
    picUrl:  item.al?.picUrl || '',
  }))
}

async function getSongDetail(songId) {
  const data = await plainPost(API.SONG_DETAIL, {
    c: JSON.stringify([{ id: Number(songId), v: 0 }]),
  })
  if (data.code !== 200) throw new Error(data.message || '获取歌曲信息失败')
  const song = data.songs?.[0]
  if (!song) throw new Error('未找到歌曲')
  return {
    id:       String(song.id),
    name:     song.name,
    artists:  song.ar?.map(a => a.name).join('/') || '未知',
    album:    song.al?.name || '未知专辑',
    picUrl:   song.al?.picUrl || getPicUrl(song.al?.pic),
    duration: song.dt || 0,
  }
}

async function getSongUrl(songId, quality) {
  const payload = {
    ids:        [Number(songId)],
    level:      quality,
    encodeType: 'flac',
  }
  if (quality === 'sky') payload.immerseType = 'c51'
  const data = await eapiPost(API.SONG_URL, payload)
  if (data.code !== 200) throw new Error(data.message || '获取播放链接失败')
  const item = data.data?.[0]
  if (!item?.url) return null
  return {
    url:   item.url,
    type:  item.type || 'mp3',
    size:  item.size || 0,
    level: item.level || quality,
  }
}

/** 从 preferredQuality 开始依次降级，直到获取到有效 URL */
async function getSongUrlWithFallback(songId, preferredQuality) {
  const startIdx = QUALITY_ORDER.indexOf(preferredQuality)
  const tryList  = startIdx >= 0 ? QUALITY_ORDER.slice(startIdx) : QUALITY_ORDER

  for (const q of tryList) {
    try {
      const result = await getSongUrl(songId, q)
      if (result?.url) return result
    } catch (err) {
      logger.warn(`[网易云] 音质 ${q} 失败: ${err.message}`)
    }
  }
  return null
}

async function getLyric(songId) {
  const data = await plainPost(API.LYRIC, {
    id: songId, cp: 'false',
    tv: 0, lv: 0, rv: 0, kv: 0, yv: 0, ytv: 0, yrv: 0,
  }, true)
  if (data.code !== 200) throw new Error(data.message || '获取歌词失败')
  return {
    lrc:    data.lrc?.lyric    || '',
    tlyric: data.tlyric?.lyric || '',
  }
}

// ─────────────────────────────────────────────────────────────
// 下载工具
// ─────────────────────────────────────────────────────────────
function ensureTmpDir() {
  fs.mkdirSync(TMP_DIR, { recursive: true })
}

/**
 * 下载文件到本地临时目录
 * 使用 close 事件确保文件描述符已完全关闭，数据落盘
 */
async function downloadToTmp(url, ext) {
  ensureTmpDir()
  const filepath = path.join(
    TMP_DIR,
    `netease_${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`
  )

  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Referer': REFERER },
    timeout: 90_000,
  })
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`)

  // 等待 close 事件：确保文件描述符已关闭，数据完全写入磁盘
  await new Promise((resolve, reject) => {
    const writer = createWriteStream(filepath)
    writer.on('error', reject)
    writer.on('close', resolve)
    res.body.on('error', reject)
    res.body.pipe(writer)
  })

  // 验证文件
  if (!fs.existsSync(filepath)) {
    throw new Error('写入后文件不存在，磁盘可能已满')
  }
  const stat = fs.statSync(filepath)
  if (stat.size === 0) {
    fs.unlinkSync(filepath)
    throw new Error('下载文件为空')
  }

  logger.info(`[网易云] 下载完成: ${filepath} (${(stat.size / 1024 / 1024).toFixed(2)} MB)`)
  return filepath
}

/**
 * 延迟删除临时文件
 * 给框架足够时间读取文件后再清理
 */
function cleanTmp(filepath, delayMs = 60_000) {
  if (!filepath) return
  setTimeout(() => {
    try {
      if (fs.existsSync(filepath)) {
        fs.unlinkSync(filepath)
        logger.info(`[网易云] 已清理临时文件: ${filepath}`)
      }
    } catch (e) {
      logger.warn(`[网易云] 清理临时文件失败: ${e.message}`)
    }
  }, delayMs)
}

// ─────────────────────────────────────────────────────────────
// 格式工具
// ─────────────────────────────────────────────────────────────
function formatSize(bytes) {
  if (!bytes) return '未知'
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function formatDuration(ms) {
  if (!ms) return '00:00'
  const s = Math.floor(ms / 1000)
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

function buildInfoText(detail, urlInfo, sendMode) {
  const qualityName = QUALITY_NAMES[urlInfo?.level] || urlInfo?.level || '未知'
  const modeName    = sendMode === 'record' ? '🎤 语音(128k)' : '📁 文件'
  return [
    `🎵 ${detail.name}`,
    `👤 ${detail.artists}`,
    `💿 ${detail.album}`,
    `⏱ ${formatDuration(detail.duration)}`,
    `🎼 音质：${qualityName}`,
    `📦 大小：${formatSize(urlInfo?.size)}`,
    `📤 发送：${modeName}`,
  ].join('\n')
}

function buildSearchText(songs) {
  const lines = songs.map((s, i) =>
    `${i + 1}. ${s.name}\n   歌手：${s.artists}\n   专辑：${s.album}`
  )
  return `🎵 搜索结果（回复序号选歌，${SESSION_TIMEOUT / 1000}s 超时）：\n\n${lines.join('\n\n')}`
}

// ─────────────────────────────────────────────────────────────
// 插件主体
// ─────────────────────────────────────────────────────────────
export class NeteaseMusic extends plugin {
  constructor() {
    super({
      name:     '网易云音乐',
      dsc:      '网易云音乐解析、搜索、音质/发送方式切换',
      event:    'message',
      priority: 30,
      rule: [
        {
          reg: /^#点歌\s*(.+)$/,
          fnc: 'cmdSearch',
        },
        {
          reg: /^#解析\s*(.+)$/,
          fnc: 'cmdParse',
        },
        {
          reg: /^#歌词\s*(.+)$/,
          fnc: 'cmdLyric',
        },
        {
          reg: /^#网易音质\s*(\S+)$/,
          fnc: 'cmdSetQuality',
          permission: 'master',
        },
        {
          reg: /^#网易发送\s*(\S+)$/,
          fnc: 'cmdSetSendMode',
          permission: 'master',
        },
        {
          reg: /^#网易状态$/,
          fnc: 'cmdStatus',
        },
        {
          reg: /^[1-8]$/,
          fnc: 'cmdSelect',
        },
        {
          reg: /./,
          fnc: 'cmdAutoDetect',
        },
      ],
    })
  }

  // ── #点歌 ─────────────────────────────────────
  async cmdSearch(e) {
    const keywords = e.msg.replace(/^#点歌\s*/, '').trim()
    if (!keywords) return e.reply('请输入搜索关键词')

    let songs
    try {
      songs = await searchMusic(keywords)
    } catch (err) {
      logger.error(`[网易云] 搜索失败: ${err.message}`)
      return e.reply(`搜索失败：${err.message}`)
    }

    if (!songs.length) return e.reply('没有找到相关歌曲')

    const key   = `${e.user_id}_${e.group_id || e.user_id}`
    const timer = setTimeout(() => pendingSessions.delete(key), SESSION_TIMEOUT)
    pendingSessions.set(key, { songs, timer })

    await e.reply(buildSearchText(songs))
    return true
  }

  // ── 选歌序号 ────────────────────────────────────
  async cmdSelect(e) {
    const key     = `${e.user_id}_${e.group_id || e.user_id}`
    const session = pendingSessions.get(key)
    if (!session) return false

    const idx = parseInt(e.msg, 10) - 1
    if (idx < 0 || idx >= session.songs.length) {
      return e.reply(`请输入 1～${session.songs.length} 之间的序号`)
    }

    clearTimeout(session.timer)
    pendingSessions.delete(key)
    await this._sendSong(e, String(session.songs[idx].id))
    return true
  }

  // ── #解析 ──────────────────────────────────────
  async cmdParse(e) {
    const input  = e.msg.replace(/^#解析\s*/, '').trim()
    const result = await extractSongId(input)
    if (!result?.id) return e.reply('无法识别歌曲 ID 或链接')
    await this._sendSong(e, result.id)
    return true
  }

  // ── 自动识别网易云分享 ────────────────────────────
  async cmdAutoDetect(e) {
    if (!isNeteaseShare(e)) return false

    const result = await extractIdFromEvent(e)
    if (!result?.id) return false

    await this._sendSong(e, result.id)
    return true
  }

  // ── #歌词 ──────────────────────────────────────
  async cmdLyric(e) {
    const input  = e.msg.replace(/^#歌词\s*/, '').trim()
    const result = await extractSongId(input)
    if (!result?.id) return e.reply('无法识别歌曲 ID 或链接')

    let detail, lyric
    try {
      ;[detail, lyric] = await Promise.all([
        getSongDetail(result.id),
        getLyric(result.id),
      ])
    } catch (err) {
      logger.error(`[网易云] 获取歌词失败: ${err.message}`)
      return e.reply(`获取失败：${err.message}`)
    }

    if (!lyric.lrc) return e.reply(`《${detail.name}》暂无歌词`)

    const lines = lyric.lrc
      .split('\n')
      .filter(l => l.trim() && !/^\[by:/.test(l))
      .slice(0, 50)
      .join('\n')

    await e.reply(
      `🎵《${detail.name}》- ${detail.artists}` +
      `${lyric.tlyric ? '（含翻译）' : ''}\n\n${lines}`
    )
    return true
  }

  // ── #网易音质 ──────────────────────────────────
  async cmdSetQuality(e) {
    const input = e.msg.replace(/^#网易音质\s*/, '').trim().toLowerCase()
    const aliases = {
      master:   'jymaster',
      jymaster: 'jymaster',
      hires:    'hires',
      lossless: 'lossless',
      flac:     'lossless',
      exhigh:   'exhigh',
      '320':    'exhigh',
      standard: 'standard',
      '128':    'standard',
    }
    const quality = aliases[input]
    if (!quality) {
      return e.reply(
        '不支持的音质档位，可选：\n' +
        'master（超清母带）\n' +
        'hires（Hi-Res）\n' +
        'lossless（无损 FLAC）\n' +
        'exhigh（极高 320k）\n' +
        'standard（标准 128k）\n' +
        '\n无对应会员权限时自动降级\n' +
        '注意：语音模式固定使用 128k，此设置仅影响文件模式'
      )
    }
    const cfg = loadConfig()
    cfg.quality = quality
    saveConfig(cfg)
    return e.reply(
      `✅ 文件模式首选音质已设为：${QUALITY_NAMES[quality]}\n` +
      `（无权限时自动顺延降级）\n` +
      `语音模式固定使用标准 128k`
    )
  }

  // ── #网易发送 ──────────────────────────────────
  async cmdSetSendMode(e) {
    const input = e.msg.replace(/^#网易发送\s*/, '').trim().toLowerCase()
    if (!['file', 'record'].includes(input)) {
      return e.reply(
        '发送方式可选：\n' +
        'file（群文件，按配置音质）\n' +
        'record（语音消息，固定 128k）'
      )
    }
    const cfg = loadConfig()
    cfg.sendMode = input
    saveConfig(cfg)
    return e.reply(
      input === 'record'
        ? '✅ 发送方式已设为：🎤 语音消息（固定标准 128k，避免转码失败）'
        : '✅ 发送方式已设为：📁 群文件（按配置音质发送）'
    )
  }

  // ── #网易状态 ──────────────────────────────────
  async cmdStatus(e) {
    const quality  = getPreferredQuality()
    const sendMode = getSendMode()
    const hasCookie = !!readCookie()
    return e.reply([
      '📊 网易云插件当前配置',
      `🎼 文件模式音质：${QUALITY_NAMES[quality] || quality}`,
      `📤 发送方式：${sendMode === 'record' ? '🎤 语音消息（固定 128k）' : '📁 群文件'}`,
      `🍪 Cookie：${hasCookie ? '✅ 已配置' : '❌ 未配置（只能解析低音质）'}`,
      `📂 临时目录：${TMP_DIR}`,
    ].join('\n'))
  }

  // ── 核心：解析并发送歌曲 ────────────────────────
  async _sendSong(e, songId) {
    await e.reply('🎵 解析中，请稍候...')

    // ── 1. 获取歌曲元信息 ──
    let detail
    try {
      detail = await getSongDetail(songId)
    } catch (err) {
      logger.error(`[网易云] 获取元信息失败 id=${songId}: ${err.message}`)
      return e.reply(`获取歌曲信息失败：${err.message}`)
    }

    // ── 2. 确定音质策略 ──
    const sendMode = getSendMode()

    // 语音模式：固定使用 standard(128k mp3)，避免 FLAC 转码失败
    // 文件模式：按配置音质并自动降级
    const preferredQuality = sendMode === 'record' ? 'standard' : getPreferredQuality()

    // ── 3. 获取播放链接 ──
    const urlInfo = await getSongUrlWithFallback(songId, preferredQuality)

    if (!urlInfo?.url) {
      return e.reply(
        `《${detail.name}》无法获取播放链接\n` +
        `可能原因：\n• 未配置黑胶 Cookie\n• 版权限制\n• 当前账号无此音质权限`
      )
    }

    // ── 4. 发送信息卡片 ──
    await e.reply(buildInfoText(detail, urlInfo, sendMode))

    const ext = (urlInfo.type || 'mp3').toLowerCase()

    // ── 5. 下载文件 ──
    let tmpFile = null
    try {
      tmpFile = await downloadToTmp(urlInfo.url, ext)
    } catch (err) {
      logger.error(`[网易云] 下载失败: ${err.message}`)
      return e.reply(`⚠️ 文件下载失败，直链（约20分钟有效）：\n${urlInfo.url}`)
    }

    // ── 6. 发送前验证文件可读 ──
    try {
      const stat = fs.statSync(tmpFile)
      logger.info(`[网易云] 准备发送: ${tmpFile} (${(stat.size / 1024 / 1024).toFixed(2)} MB)`)
    } catch (statErr) {
      logger.error(`[网易云] 文件验证失败: ${statErr.message}`)
      cleanTmp(tmpFile, 0)
      return e.reply(`⚠️ 临时文件异常，直链：\n${urlInfo.url}`)
    }

    // ── 7. 发送 ──
    let sendOk = false

    if (sendMode === 'record') {
      // 语音模式
      try {
        await e.reply({
          type: 'record',
          data: { file: `file://${tmpFile}` },
        })
        sendOk = true
      } catch (err) {
        logger.warn(`[网易云] 语音发送失败: ${err.message}`)
        await e.reply(`⚠️ 语音发送失败，直链（约20分钟有效）：\n${urlInfo.url}`)
      }
    } else {
      // 文件模式
      const filename = `${detail.name} - ${detail.artists}.${ext}`
        .replace(/[\\/:*?"<>|]/g, '_')
        .slice(0, 180)

      try {
        await e.reply({
          type: 'file',
          data: {
            file: `file://${tmpFile}`,
            name: filename,
          },
        })
        sendOk = true
      } catch (err) {
        logger.warn(`[网易云] 文件发送失败: ${err.message}`)
        await e.reply(`⚠️ 文件发送失败，直链（约20分钟有效）：\n${urlInfo.url}`)
      }
    }

    // ── 8. 清理临时文件 ──
    // 成功：延迟 60s（给框架足够时间读取）
    // 失败：立即清理
    cleanTmp(tmpFile, sendOk ? 60_000 : 0)

    return true
  }
}
