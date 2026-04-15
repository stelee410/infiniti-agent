Live2D 模型目录（与 Open-LLM-VTuber 的 live2d-models 布局相同）

将已下载的模型整夹复制到本目录下，例如：
  live2d-models/mao_pro/runtime/mao_pro.model3.json

若从 Open-LLM-VTuber 仓库拷贝，可直接复制其项目根目录下的整个 live2d-models 文件夹到本项目的 live2d-models（或与 config 中 live2dModelsDir 一致的路径）。

然后在项目根执行：npm run setup:liveui
（会把 liveUi 写入 .infiniti-agent/config.json，并在需要时复制 model_dict.example.json 为 ./model_dict.json）
