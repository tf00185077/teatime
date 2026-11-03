# 下午茶筆記（PWA）

記錄想去、去過的下午茶店。資料存在手機本地（IndexedDB），可以離線使用。

## 功能
- 新增／編輯／刪除店家：店名、地區、地址或地圖連結、想去/去過、評分、造訪日期、價位、標籤、筆記、照片
- 篩選（全部／想去／去過）、搜尋、排序
- 一鍵開啟 Google 地圖
- 匯出／匯入 JSON 備份

## 部署到 GitHub Pages（免費）
1. 在 GitHub 建一個新 repo（例如 `tea-notes`），把這個資料夾所有檔案放到根目錄並 push。
2. Repo → Settings → Pages → Source 選 `Deploy from a branch`，Branch 選 `main` / `(root)`，儲存。
3. 等一兩分鐘，網址會是 `https://<你的帳號>.github.io/tea-notes/`。

（也可以用 Cloudflare Pages / Vercel / Netlify，直接拖拉資料夾或連 GitHub。）

## 加到 iPhone 主畫面
1. 用 **Safari** 打開上面的網址。
2. 點下方「分享」→「加入主畫面」→「加入」。
3. 之後從桌面圖示打開，就是全螢幕 app。

## 本機測試
```bash
python3 -m http.server 8000
# 電腦瀏覽器打開 http://localhost:8000
```
（Service Worker 需要 HTTPS 或 localhost；手機要測離線功能請用部署後的網址。）

## 更新程式
改完檔案後，把 `sw.js` 裡的 `CACHE = 'tea-notes-v1'` 版本號加 1 再部署，手機關掉 app 重開一兩次就會換成新版。

## 注意
- 資料只存在那台裝置的那個瀏覽器（從主畫面開的 app 跟 Safari 分頁的資料是分開的）。
- iOS 可能清除很久沒開的網站資料，請定期用「⋯ → 匯出備份」存一份到「檔案」或雲端。
