import { Injectable, HttpException } from '@nestjs/common';
import { config } from './config';

@Injectable()
export class TokendanceService {
  private readonly base = 'https://tokendance.space/gateway/v1';
  private readonly arkBase = 'https://tokendance.space/gateway/ark/v3';
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
}