Live2D 模型目录（与 Open-LLM-VTuber 的 live2d-models 布局相同）

本机若已从 Open-LLM-VTuber 同步，应包含例如：
  mao_pro/runtime/mao_pro.model3.json
  shizuku/runtime/shizuku.model3.json

若目录为空，可将 VTuber 项目根目录下的整个 live2d-models 内容 rsync/cp 到本目录（与 config 中 live2dModelsDir 一致，默认 ./live2d-models）。

在项目根执行：npm run setup:liveui
可合并 liveUi 到 .infiniti-agent/config.json，并在需要时复制 model_dict.example.json 为 ./model_dict.json。
