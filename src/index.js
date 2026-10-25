const { execFile } = require('child_process')
const path = require('path')
const fs = require('fs')
const os = require('os')

// cjxl が対応可能な拡張子（大文字小文字問わず判定）
const SUPPORTED_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'apng', 'webp', 'bmp', 'exr', 'pam', 'ppm'])

// DOM要素の取得
const qualitySlider = document.getElementById('quality')
const qualityVal = document.getElementById('quality-val')
const effortSlider = document.getElementById('effort')
const effortVal = document.getElementById('effort-val')
const convertBtn = document.getElementById('convert-btn')
const itemSummary = document.getElementById('item-summary')
const typeBreakdown = document.getElementById('type-breakdown')
const progressEl = document.getElementById('progress')
const logEl = document.getElementById('log')

// cjxl.exe のパス解決（src/ の親ディレクトリにある bin/cjxl.exe）
const CJXL_PATH = path.join(__dirname, '..', 'bin', process.platform === 'win32' ? 'cjxl.exe' : 'cjxl')

let targetItems = []

// ログ出力用ユーティリティ
function log(msg) {
  logEl.textContent += msg + '\n'
  logEl.scrollTop = logEl.scrollHeight
}

// スライダー値変更イベント: 品質 (Quality)
qualitySlider.addEventListener('input', (e) => {
  const val = e.target.value
  qualityVal.textContent = val === '100' ? '100 (完全ロスレス)' : val
})

// スライダー値変更イベント: 圧縮率 (Effort)
effortSlider.addEventListener('input', (e) => {
  const val = e.target.value
  const labels = { 1: '最速', 7: '標準', 9: '最大圧縮' }
  effortVal.textContent = labels[val] ? `${val} (${labels[val]})` : val
})

// プラグイン起動時の初期化処理
eagle.onPluginCreate(async () => {
  // cjxl バイナリの存在チェック
  if (!fs.existsSync(CJXL_PATH)) {
    log('【エラー】エンコーダーが見つかりません。')
    log(`配置先: ${CJXL_PATH}`)
    log('READMEの指示に従って bin フォルダに cjxl.exe を配置してください。')
    convertBtn.disabled = true
    return
  }

  // Eagle上で現在選択されている画像を取得
  const selected = await eagle.item.getSelected()

  // 対象拡張子であり、かつ既に .jxl でないものを抽出
  targetItems = selected.filter((item) => {
    const ext = (item.ext || '').toLowerCase()
    return ext !== 'jxl' && SUPPORTED_EXTS.has(ext)
  })

  itemSummary.textContent = `${targetItems.length} 件 (選択中: ${selected.length} 件)`

  if (targetItems.length === 0) {
    convertBtn.disabled = true
    log('変換対象の画像（PNG, JPG, WebP, GIF等）が選択されていません。')
    return
  }

  // 選択アイテムの拡張子内訳を集計・表示
  const counts = {}
  targetItems.forEach((i) => {
    const ext = i.ext.toUpperCase()
    counts[ext] = (counts[ext] || 0) + 1
  })
  typeBreakdown.textContent = Object.entries(counts)
    .map(([k, v]) => `${k}: ${v}`)
    .join(' | ')

  log(`準備完了: ${targetItems.length} 件のアイテムを変換可能です。`)
})

// 変換実行ボタンのクリックイベント
convertBtn.addEventListener('click', async () => {
  // UIの操作をロック
  convertBtn.disabled = true
  qualitySlider.disabled = true
  effortSlider.disabled = true

  progressEl.style.display = 'block'
  progressEl.max = targetItems.length
  progressEl.value = 0

  const quality = parseInt(qualitySlider.value, 10)
  const effort = effortSlider.value

  let successCount = 0
  let failCount = 0
  let totalSavedBytes = 0

  log(`\n========================================`)
  log(`変換開始 [Quality: ${quality}, Effort: ${effort}]`)
  log(`========================================`)

  for (let i = 0; i < targetItems.length; i++) {
    const item = targetItems[i]
    const ext = (item.ext || '').toLowerCase()
    const fileName = `${item.name}.${ext}`

    log(`[${i + 1}/${targetItems.length}] 処理中: ${fileName}`)

    // OSの一時ディレクトリに出力先を確保
    const tempJxlPath = path.join(os.tmpdir(), `eagle_jxl_${Date.now()}_${item.id}.jxl`)

    try {
      // 元ファイルのサイズを取得（集計用）
      const origSize = fs.existsSync(item.filePath) ? fs.statSync(item.filePath).size : item.size || 0

      // cjxl の引数設定
      const args = [item.filePath, tempJxlPath, '-e', effort]

      if (quality === 100) {
        // 完全ロスレス
        if (ext === 'jpg' || ext === 'jpeg') {
          // JPEGは -d 引数なしで自動的に画質無劣化トランスコード（約20%削減）
        } else {
          // PNG等のラスタ形式は distance 0（完全可逆）
          args.push('-d', '0')
        }
      } else {
        // 不可逆圧縮（Quality指定）
        args.push('-q', quality.toString())
      }

      // cjxl プロセスの実行
      await new Promise((resolve, reject) => {
        execFile(CJXL_PATH, args, (err, stdout, stderr) => {
          if (err) {
            return reject(new Error(stderr ? stderr.trim() : err.message))
          }
          resolve()
        })
      })

      // 出力検証
      if (!fs.existsSync(tempJxlPath) || fs.statSync(tempJxlPath).size === 0) {
        throw new Error('生成されたJXLファイルが不正または空です')
      }

      const newSize = fs.statSync(tempJxlPath).size

      // Eagle 公式 API で本体ファイルを置換
      // ※ Eagle が自動的にメタデータ更新・サムネイル再生成・パレット再計算を行います
      const replaced = await item.replaceFile(tempJxlPath)

      if (!replaced && replaced !== undefined) {
        throw new Error('Eagleのファイル置換処理(replaceFile)が失敗しました')
      }

      successCount++
      const saved = origSize - newSize
      if (saved > 0) {
        totalSavedBytes += saved
      }

      const savedKB = (saved / 1024).toFixed(1)
      log(`  ✔ 完了 (削減: ${savedKB} KB)`)
    } catch (err) {
      failCount++
      log(`  ❌ 失敗: ${err.message}`)
    } finally {
      // 処理が成功・失敗に関わらず一時ファイルを確実にクリーンアップ
      if (fs.existsSync(tempJxlPath)) {
        try {
          fs.unlinkSync(tempJxlPath)
        } catch (_) {}
      }
    }

    // 進捗バー更新
    progressEl.value = i + 1
  }

  // 終了サマリーの表示
  log(`\n========================================`)
  log(`すべての処理が完了しました`)
  log(`成功: ${successCount} 件 / 失敗: ${failCount} 件`)
  if (totalSavedBytes > 0) {
    const savedMB = (totalSavedBytes / (1024 * 1024)).toFixed(2)
    log(`合計削減容量: ${savedMB} MB`)
  }
  log(`========================================`)

  convertBtn.textContent = '変換完了'
})
