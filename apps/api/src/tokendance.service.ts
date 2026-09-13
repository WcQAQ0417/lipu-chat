import { Injectable, HttpException } from '@nestjs/common';
import { config } from './config';

@Injectable()
export class TokendanceService {
  private readonly base = 'https://tokendance.space/gateway/v1';
  private readonly arkBase = 'https://tokendance.space/gateway/ark/v3';
  private readonly klingBase = 'https://tokendance.space/gateway/kling/v1';
  private get key() { return config.tokendance.apiKey; }
  private get enabled() { return config.tokendance.enabled; }

  private headers() {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.key}`,
    };
  }

  /** 文生图 */
  async generateImage(prompt: string): Promise<string> {
    if (!this.enabled) throw new HttpException('TokenDance 未配置', 503);
    const response = await fetch(`${this.base}/images/generations`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        model: config.tokendance.imageModel,
        prompt,
        n: 1,
        size: '1024x1024',
      }),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new HttpException(`图像生成失败 (${response.status}): ${text.slice(0, 200)}`, response.status);
    }
    const body = await response.json() as { data?: Array<{ url?: string }> };
    const url = body.data?.[0]?.url;
    if (!url) throw new HttpException('图像生成返回无图片 URL', 502);
    return url;
  }

  /** 图文生图：基于参考图 + 提示词生成新图（ARK 协议 / Seedream） */
  async generateImageWithRef(prompt: string, imageBase64: string): Promise<string> {
    if (!this.enabled) throw new HttpException('TokenDance 未配置', 503);
    const response = await fetch(`${this.arkBase}/images/generations`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        model: config.tokendance.imageModel,
        prompt,
        image: `data:image/png;base64,${imageBase64}`,
        size: '2K',
        output_format: 'png',
        response_format: 'url',
        watermark: false,
      }),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new HttpException(`图文生成失败 (${response.status}): ${text.slice(0, 200)}`, response.status);
    }
    const body = await response.json() as { data?: Array<{ url?: string }> };
    const url = body.data?.[0]?.url;
    if (!url) throw new HttpException('图文生成返回无图片 URL', 502);
    return url;
  }

  /** 图生视频：使用 Kling 3.0 image2video */
  async generateVideo(imageUrl: string, prompt: string): Promise<string> {
    if (!this.enabled) throw new HttpException('TokenDance 未配置', 503);

    // 1. 提交 Kling image2video 任务
    const submitBody = JSON.stringify({
      model_name: config.tokendance.videoModel,
      contents: [
        { type: 'prompt', text: prompt },
        { type: 'first_frame', url: imageUrl },
      ],
      settings: {
        resolution: '720p',
        duration: 5,
        aspect_ratio: '1:1',
      },
      options: {
        watermark_info: { enabled: false },
      },
    });

    const submitRes = await fetch(`${this.klingBase}/image2video`, {
      method: 'POST',
      headers: this.headers(),
      body: submitBody,
    });

    if (!submitRes.ok) {
      const text = await submitRes.text();
      throw new HttpException(`视频任务创建失败 (${submitRes.status}): ${text.slice(0, 200)}`, submitRes.status);
    }

    const submitData = await submitRes.json() as { data?: { id?: string } };
    const taskId = submitData?.data?.id;
    if (!taskId) throw new HttpException('视频任务创建返回无任务 ID', 502);

    // 2. 轮询任务结果（最多 120 秒）
    for (let i = 0; i < 24; i++) {
      await new Promise(r => setTimeout(r, 5000));

      const pollRes = await fetch(`${this.klingBase}/image2video/${taskId}`, {
        headers: this.headers(),
      });

      if (!pollRes.ok) {
        const text = await pollRes.text();
        throw new HttpException(`视频状态查询失败 (${pollRes.status}): ${text.slice(0, 200)}`, pollRes.status);
      }

      const pollData = await pollRes.json() as {
        data?: Array<{ status?: string; outputs?: Array<{ type?: string; url?: string }> }>;
      };

      const task = pollData?.data?.[0];
      if (!task) continue;

      const status = task.status;

      if (status === 'succeeded') {
        const videoOutput = task.outputs?.find(o => o.type === 'video');
        const videoUrl = videoOutput?.url;
        if (!videoUrl) throw new HttpException('视频生成成功但无视频 URL', 502);
        return videoUrl;
      }

      if (status === 'failed' || status === 'error') {
        const msg = task.outputs?.[0] ? JSON.stringify(task.outputs[0]) : '视频生成失败';
        throw new HttpException(msg, 502);
      }

      // 'submitted' / 'processing' — continue polling
    }

    throw new HttpException('视频生成超时', 504);
  }
}