# 糯叽桌宠 Nuoji Pet

一只住在 SillyTavern 页面里的银白猫狐。糯叽会听你说话、陪模型思考、迎接新回复，也可以被拖到屏幕上任意位置——但我们不把她喂成可露丽那么胖。

这是 GPT × Ripple 一起搓的首个可玩版本 `v0.1.0`。

![糯叽的八种首版状态](docs/state-preview.png)

## 现在会什么

- 悬浮在 SillyTavern 页面上，不挡住整页操作
- 鼠标和手机触摸都能拖动，位置会保存
- 点一下或按 Enter / 空格可以摸摸糯叽
- 根据酒馆事件自动切换动作：
  - 发出消息：认真听
  - 开始生成：思考
  - 流式输出：轻微呼吸反馈
  - 收到回复：开心
  - 停止或异常结束：迷糊
  - 切换聊天：挥爪跟上
- 设置面板可调整显示、大小、透明度、气泡和动态效果
- 适配 iPhone 安全视口、触摸拖动和屏幕旋转
- 不调用模型、不发送聊天内容、不额外消耗 token

首版造型由 Canvas 程序实时绘制，所以开箱即用、Retina 屏也清楚。之后可以保持事件和交互代码不变，只替换成精细透明动画素材。

## 本地安装测试

1. 解压下载包。
2. 确认目录结构是 `nuoji-pet/manifest.json`，不要多套一层同名文件夹。
3. 把整个 `nuoji-pet` 文件夹放进：

   ```text
   SillyTavern/data/<你的用户目录>/extensions/
   ```

4. 重启 SillyTavern，或刷新酒馆页面。
5. 打开“扩展”设置，展开“糯叽桌宠”即可调大小、透明度和预览动作。

等仓库发布到 GitHub 后，也可以在 SillyTavern 的“安装扩展”里直接粘贴仓库地址安装和更新。

## 操作

- 点糯叽：摸摸她
- 拖糯叽：换位置，松手后自动保存
- 键盘选中糯叽后按 Enter / 空格：摸摸她
- 设置 → 扩展 → 糯叽桌宠：预览八种状态或重置位置

## 给其他扩展联动

页面内可以发一个自定义事件让糯叽做动作：

```js
window.dispatchEvent(new CustomEvent('nuoji:react', {
    detail: {
        state: 'happy',
        message: '找到啦！',
        duration: 1800,
    },
}));
```

也可以使用简写：

```js
window.NuojiPet.react('sleeping', '困嘟嘟…', 3000);
```

可用状态：`idle`、`listening`、`thinking`、`happy`、`confused`、`petting`、`sleeping`、`wave`。

## 文件

- `manifest.json`：SillyTavern 扩展清单
- `index.js`：事件、拖动、设置与状态机
- `pet-renderer.js`：银白猫狐 Canvas 动画
- `style.css`：悬浮层、手机适配和设置面板样式
- `settings.html`：酒馆扩展设置界面
- `preview.html`：不启动酒馆也能检查动作的本地预览页

## 性能与隐私

- Canvas 最多约 24 FPS；开启“减少动态效果”后进一步降频
- 页面切到后台时停止实际绘制
- 流式 token 事件只触发轻微视觉脉冲，不读取 token 文本
- 没有网络请求、追踪、遥测或第三方依赖

## 下一步想搓的

- 精细透明动画 / sprite sheet
- 摸摸值、好感度和小鱼干，但控制体重
- 白天、夜晚和长时间陪伴动作
- 糯叽自己的小窝与配饰

## License

[MIT](LICENSE)
