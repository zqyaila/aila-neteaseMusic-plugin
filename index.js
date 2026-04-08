import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// 插件名称
const pluginName = 'poke-plugin'

// 存储所有导出的类
const apps = {}

// 读取 apps 目录下的所有 js 文件
const appsPath = path.join(__dirname, 'apps')

if (fs.existsSync(appsPath)) {
  const files = fs.readdirSync(appsPath).filter(file => file.endsWith('.js'))
  
  for (const file of files) {
    try {
      const filePath = path.join(appsPath, file)
      const module = await import(`file://${filePath}`)
      
      // 将模块中的所有导出类添加到 apps
      for (const [name, cls] of Object.entries(module)) {
        if (typeof cls === 'function') {
          apps[name] = cls
        }
      }
      
      logger.info(`[${pluginName}] 加载成功: ${file}`)
    } catch (err) {
      logger.error(`[${pluginName}] 加载失败: ${file}`)
      logger.error(err)
    }
  }
}

logger.info(`----- ${pluginName} 加载完成 -----`)

export { apps }
