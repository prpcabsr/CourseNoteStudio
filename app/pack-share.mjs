// 打包一个「分享给别人」的压缩包：只带程序本身（几 MB），
// 组件与模型让别人自己一键下载（约 3.5 GB），生成的作品也不打包。
// 用法：node app/pack-share.mjs
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DIST = path.join(ROOT, 'dist');
const STAGE = path.join(DIST, 'CourseNoteStudio');

const INCLUDE = ['app', 'tests', 'messages', 'package.json', 'package-lock.json', 'README.md', '启动.bat', '安装组件.bat', '打包分享.bat', '分享说明.txt'];

function rm(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

function copy(src, dst) {
  const st = fs.statSync(src);
  if (st.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    for (const name of fs.readdirSync(src)) {
      if (name === 'node_modules' || name === 'dist') continue;
      copy(path.join(src, name), path.join(dst, name));
    }
  } else {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  }
}

const GUIDE = `课程笔记工坊 · 使用说明
================================

这是一个「把大学课程视频变成 PDF 课程笔记」的小工具：
输入视频链接（B 站 / YouTube / 慕课…）或本地视频文件，它会
  · 看：逐秒追踪黑板/白板/PPT，在板书被擦掉之前保存下来
  · 听：把讲课语音转写成带时间戳的文字
  · 想：把两者对齐后整理成结构化的课程笔记
最后输出一份带板书原图、公式、术语表和复习题的 PDF。
笔记生成后，还可以在右侧 AI 面板里就着笔记直接提问。

【第一次使用】三步

1. 安装 Node.js
   到 https://nodejs.org 下载 LTS 版，一路“下一步”装完即可。

2. 双击「安装组件.bat」
   自动下载运行组件与模型（约 3.5 GB，支持断点续传），
   顺便安装排版依赖。这一步只要做一次，请耐心等它跑完。

3. 双击「启动.bat」
   浏览器会自动打开 http://127.0.0.1:7788
   在右侧「环境与模型 → 文本模型」里填入一个模型 API Key
   （DeepSeek 或任意 OpenAI 兼容接口；整理笔记那一步要用）。
   然后在首页粘贴视频链接，点「开始生成」。

   ★ 关掉所有页面后，程序会自己退出，那个黑窗口也会一起关闭，
     不用手动去关窗口。（想让它一直开着，用
     node app\\main.mjs serve --keep-open）

【界面怎么用】

· 窗口分三栏：左边是任务列表，中间是笔记，右边是 AI 面板。
  栏与栏之间的竖线可以用鼠标拖动来调宽度（双击复位），宽度会记住。
· 右侧 AI 面板一直开着，可以在阅读时随时提问：
    - 在笔记里划选文字，然后点右键 →「询问 AI」，选中的内容就会进输入框；
      右键菜单里还有「直接解释这段」（替你问好并立即发送）和「复制」。
    - 板书图片右上角有「🤖 问 AI」按钮，点一下把这张板书发给 AI。
    - 只发文字时走文本模型；带图片时自动切换成视觉模型。
    - 对话按任务保存，关掉浏览器再打开还在。

【说明】

· 视频、语音、板书全部在本机处理，不会上传到任何地方；
  只有“整理成文”和“AI 问答”这两步会把文字（以及你主动附上的图片）
  发给上面配置的模型接口。
· 第一次生成一份 90 分钟的课大约需要：板书识别 10–30 分钟
  （取决于显卡）+ 语音识别 3–5 分钟 + 整理成文 2–4 分钟。
  想更快可以先选「板书抓拍：精简」。
· 生成的 PDF 在 data\\projects\\<任务编号>\\out\\ 里，
  也可以直接在网页上点「打开 PDF」。

【没有显卡 / 下载慢】

· 没有独立显卡也能用：安装时点「安装全部（含备用模型）」会顺便下载
  CPU 版推理引擎，程序会自动回退。
· 只想用云端视觉模型：在「环境与模型 → 视觉模型」把识别方式改成
  「外部接口」，填任意 OpenAI 兼容的多模态接口，速度会快很多。

【常见问题】

Q: 双击「安装组件.bat」没反应 / 报错找不到 node？
A: 说明 Node.js 没装好，重新装一次 Node.js LTS 版即可。

Q: B 站高清视频下载失败？
A: 部分视频需要登录。在「环境与模型 → 抓拍与输出」里选择浏览器
   Cookie（Edge / Chrome / Firefox），程序会读取你已登录的会话。

Q: 生成的公式/文字有错？
A: 自动识别难免有误，建议对照原视频复核，尤其是公式与关键结论。
   也可以直接在右侧 AI 面板里把那段贴进去问它。
`;

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

async function main() {
  rm(DIST);
  fs.mkdirSync(STAGE, { recursive: true });
  let total = 0;
  const stamp = new Date().toLocaleString('zh-CN', { hour12: false });
  for (const item of INCLUDE) {
    const src = path.join(ROOT, item);
    if (item === '分享说明.txt') {
      fs.writeFileSync(path.join(STAGE, item), `打包版本：v${pkg.version}　打包时间：${stamp}\n\n` + GUIDE, 'utf8');
      continue;
    }
    if (!fs.existsSync(src)) {
      console.warn(`  跳过（不存在）：${item}`);
      continue;
    }
    copy(src, path.join(STAGE, item));
  }
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else total += fs.statSync(p).size;
    }
  };
  walk(STAGE);
  console.log(`已整理出分享版：${(total / 1048576).toFixed(1)} MB（不含组件与模型，对方首次运行会自动下载）`);

  const zip = path.join(DIST, 'CourseNoteStudio-分享版.zip');
  const ok = await new Promise((resolve) => {
    const ps = spawn('powershell', ['-NoProfile', '-Command', `Compress-Archive -Path '${STAGE}\\*' -DestinationPath '${zip}' -Force`], { windowsHide: true });
    ps.on('close', (c) => resolve(c === 0));
    ps.on('error', () => resolve(false));
  });
  if (ok && fs.existsSync(zip)) {
    console.log(`压缩包：${zip}  (${(fs.statSync(zip).size / 1048576).toFixed(1)} MB)`);
  } else {
    console.log(`压缩失败，但文件已经整理在：${STAGE}（可直接把这个文件夹发给别人）`);
  }
}

await main();
