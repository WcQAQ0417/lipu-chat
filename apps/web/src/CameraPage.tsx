import { useState, useCallback, useEffect, useRef } from 'react';

type Effect = {
  id: string;
  name: string;
  description: string;
  image_url: string | null;
  effect_type: string;
};

type ProcessResult = {
  ok: boolean;
  result: string;
  description: string;
};

type FilterType = 'none' | 'bw' | 'bc' | 'ss';

type FilterParams = {
  brightness: number;  // 50-200, default 150
  contrast: number;    // 50-200, default 120
  saturation: number;  // 50-300, default 150
  sharpness: number;   // 0-100, default 50
};

const API = (path: string) => `${import.meta.env.VITE_API_URL || ''}${path}`;
const TOKEN_KEY = '***';
const COUNT_KEY = 'effect_counts';

async function getToken(): Promise<string> {
  let token = localStorage.getItem(TOKEN_KEY);
  if (!token) {
    const res = await fetch(API('/api/session'), { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } });
    token = (await res.json()).token;
    localStorage.setItem(TOKEN_KEY, token!);
  }
  return token!;
}

async function refreshToken(): Promise<string> {
  localStorage.removeItem(TOKEN_KEY);
  return getToken();
}

async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const token = await getToken();
  const res = await fetch(API(path), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  if (res.status === 401) {
    const newToken = await refreshToken();
    const retry = await fetch(API(path), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${newToken}` },
      body: JSON.stringify(body),
    });
    if (!retry.ok) throw new Error((await retry.json()).message || '请求失败');
    return retry.json();
  }
  if (!res.ok) throw new Error((await res.json()).message || '请求失败');
  return res.json();
}

const EFFECT_ICONS: Record<string, string> = {
  '奶龙': '🦕', '奶蛙': '🐸', '猫猫': '🐱', '狗狗': '🐶',
  '熊猫': '🐼', '兔子': '🐰', '水獭': '🦦', '企鹅': '🐧',
  '考拉': '🐨', '小狮子': '🦁',
};

const FILTER_NAMES: Record<FilterType, string> = {
  none: '原图', bw: '黑白', bc: '亮度对比度', ss: '饱和度锐度',
};

const DEFAULT_PARAMS: FilterParams = {
  brightness: 130, contrast: 120, saturation: 150, sharpness: 50,
};

// 计算 CSS filter 字符串
function cssFilter(type: FilterType, params: FilterParams): string {
  switch (type) {
    case 'bw': return 'grayscale(100%)';
    case 'bc': return `brightness(${params.brightness}%) contrast(${params.contrast}%)`;
    case 'ss': return `saturate(${params.saturation}%) contrast(${100 + params.sharpness * 0.3}%)`;
    default: return 'none';
  }
}

function loadCounts(): Record<string, number> {
  try { return JSON.parse(localStorage.getItem(COUNT_KEY) || '{}'); } catch { return {}; }
}
function saveCount(counts: Record<string, number>) {
  localStorage.setItem(COUNT_KEY, JSON.stringify(counts));
}

function Slider({ label, value, min, max, step, onChange, unit }: {
  label: string; value: number; min: number; max: number; step?: number;
  onChange: (v: number) => void; unit?: string;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, width: '100%' }}>
      <span style={{ whiteSpace: 'nowrap', minWidth: 28, fontWeight: 700, flexShrink: 0 }}>{label}</span>
      <input type="range" min={min} max={max} step={step ?? 1} value={value}
        onChange={e => onChange(Number(e.target.value))}
        style={{ flex: 1, accentColor: 'var(--lime)', height: 4, minWidth: 0, width: 0 }}
      />
      <span style={{ minWidth: 30, textAlign: 'right', color: '#555', flexShrink: 0 }}>{value}{unit ?? '%'}</span>
    </div>
  );
}

export function CameraPage({ onBack }: { onBack: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [effects, setEffects] = useState<Effect[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [facingMode, setFacingMode] = useState<'user' | 'environment'>('user');
  const [cameraReady, setCameraReady] = useState(false);
  const [cameraError, setCameraError] = useState('');
  const [counts, setCounts] = useState<Record<string, number>>(loadCounts);
  const [surpriseUnlocked, setSurpriseUnlocked] = useState(false);
  const [filterType, setFilterType] = useState<FilterType>('none');
  const [filterParams, setFilterParams] = useState<FilterParams>(DEFAULT_PARAMS);
  const [showAddModal, setShowAddModal] = useState(false);
  const [addName, setAddName] = useState('');
  const [addDesc, setAddDesc] = useState('');
  const [addIcon, setAddIcon] = useState('🦕');
  const [addImageB64, setAddImageB64] = useState('');
  const [adding, setAdding] = useState(false);
  const [originalFrame, setOriginalFrame] = useState<string | null>(null);
  const [generatingVideo, setGeneratingVideo] = useState(false);
  const [videoBlobUrl, setVideoBlobUrl] = useState<string | null>(null);
  const effectImgRef = useRef<HTMLImageElement | null>(null);

  useEffect(() => {
    const unlocked = Object.values(counts).some(c => c >= 5);
    setSurpriseUnlocked(unlocked);
  }, [counts]);

  useEffect(() => {
    fetch(API('/api/effects')).then(r => r.json()).then(setEffects).catch(() => {});
  }, []);

  const startCamera = useCallback(async () => {
    setCameraError('');
    setCameraReady(false);
    try {
      const s = await navigator.mediaDevices.getUserMedia({
        video: { facingMode, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
      streamRef.current = s;
      const video = videoRef.current;
      if (video) {
        video.onloadedmetadata = () => {
          video.play().then(() => setCameraReady(true)).catch(() => {});
        };
        video.srcObject = s;
      }
    } catch (err: any) {
      if (err.name === 'NotAllowedError')
        setCameraError('摄像头权限被拒绝，请在浏览器设置中允许访问摄像头');
      else if (err.name === 'NotFoundError')
        setCameraError('未检测到摄像头');
      else
        setCameraError('无法启动摄像头：' + (err.message || '未知错误'));
    }
  }, [facingMode]);

  const stopStream = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    }
  }, []);

  useEffect(() => {
    startCamera();
    return () => stopStream();
  }, [facingMode, startCamera, stopStream]);

  const switchCamera = useCallback(() => {
    stopStream();
    setCameraReady(false);
    setFacingMode(prev => prev === 'user' ? 'environment' : 'user');
  }, [stopStream]);

  const captureFrame = useCallback((): string | null => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || !video.videoWidth) return null;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d')!;
    // 应用背景滤镜到画布
    const f = cssFilter(filterType, filterParams);
    if (f !== 'none') ctx.filter = f;
    if (facingMode === 'user') {
      ctx.translate(canvas.width, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(video, 0, 0);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.filter = 'none';
    return canvas.toDataURL('image/jpeg', 0.85);
  }, [facingMode, filterType, filterParams]);

  const takePhoto = useCallback(async () => {
    if (!selected) { setError('请先选择一个特效'); return; }
    if (!cameraReady) { setError('摄像头还没准备好'); return; }
    const frame = captureFrame();
    if (!frame) { setError('拍照失败'); return; }
    setError('');
    setVideoBlobUrl(null);
    setOriginalFrame(frame);
    setLoading(true);
    setPreview(null);
    stopStream();
    setCameraReady(false);
    try {
      const data = await apiPost<ProcessResult>('/api/effects/process', {
        effect_id: selected,
        image: frame,
      });
      setPreview(data.result);
      const newCounts = { ...loadCounts(), [selected]: (counts[selected] || 0) + 1 };
      setCounts(newCounts);
      saveCount(newCounts);
    } catch (err: any) {
      setError(err.message || '处理失败');
      startCamera();
    }
    setLoading(false);
  }, [selected, cameraReady, captureFrame, stopStream, startCamera, counts]);

  const surprisePhoto = useCallback(async () => {
    if (!cameraReady || effects.length === 0) return;
    const idx = Math.floor(Math.random() * effects.length);
    setSelected(effects[idx].id);
    setError('');
    const frame = captureFrame();
    if (!frame) { setError('拍照失败'); return; }
    setLoading(true);
    setPreview(null);
    stopStream();
    setCameraReady(false);
    try {
      const data = await apiPost<ProcessResult>('/api/effects/process', {
        effect_id: effects[idx].id,
        image: frame,
      });
      setPreview(data.result);
      const newCounts = { ...loadCounts(), [effects[idx].id]: (counts[effects[idx].id] || 0) + 1 };
      setCounts(newCounts);
      saveCount(newCounts);
    } catch (err: any) {
      setError(err.message || '处理失败');
      startCamera();
    }
    setLoading(false);
  }, [cameraReady, effects, captureFrame, stopStream, startCamera, counts]);

  const saveImage = useCallback(() => {
    if (!preview) return;
    const a = document.createElement('a');
    a.href = preview;
    const eff = effects.find(e => e.id === selected);
    a.download = `变身_${eff?.name || 'photo'}_${Date.now()}.jpg`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }, [preview, selected, effects]);

  const resetCamera = useCallback(() => {
    setSelected(null);
    setPreview(null);
    setError('');
    setLoading(false);
    setVideoBlobUrl(null);
    startCamera();
  }, [startCamera]);

  const clearCounts = useCallback(() => {
    setCounts({});
    saveCount({});
    setSurpriseUnlocked(false);
  }, []);

  // 生成变身视频（客户端 canvas 过渡动画：原图 → 特效图）
  const generateVideo = useCallback(async () => {
    if (!preview || !originalFrame) return;
    setGeneratingVideo(true);
    setError('');
    try {
      const [origImg, effImg] = await Promise.all([
        loadImage(originalFrame),
        loadImage(preview),
      ]);

      // Canvas 宽高比与原始照片一致（contain 模式，完整显示人像）
      const W = 640;
      const origAspect = origImg.width / origImg.height;
      const H = Math.round(W / origAspect);
      const canvas = document.createElement('canvas');
      canvas.width = W;
      canvas.height = H;
      const ctx = canvas.getContext('2d')!;

      const stream = canvas.captureStream(30);
      const chunks: Blob[] = [];
      const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' });
      recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };

      const fps = 30;
      const duration = 3;
      const totalFrames = fps * duration;
      let frame = 0;

      recorder.start();

      await new Promise<void>(resolve => {
        recorder.onstop = () => resolve();

        // 居中绘制图片，contain 模式（完整显示，自动黑边填充）
        function drawImg(img: HTMLImageElement, alpha = 1, scale = 1) {
          const iw = img.width, ih = img.height;
          const imgRatio = iw / ih;
          const canvasRatio = W / H;

          let dw: number, dh: number;
          if (imgRatio > canvasRatio) {
            // 图片更宽 → 按高度撑满，左右留黑边
            dh = H * scale;
            dw = dh * imgRatio;
          } else {
            // 图片更高 → 按宽度撑满，上下留黑边
            dw = W * scale;
            dh = dw / imgRatio;
          }

          const dx = (W - dw) / 2;
          const dy = (H - dh) / 2;

          ctx.save();
          ctx.globalAlpha = alpha;
          ctx.drawImage(img, 0, 0, iw, ih, dx, dy, dw, dh);
          ctx.restore();
        }

        function tick() {
          const t = frame / totalFrames;

          // 黑底（letterboxing 背景）
          ctx.fillStyle = '#000';
          ctx.fillRect(0, 0, W, H);

          if (t < 0.2) {
            // Phase 1: 原图亮相（0-0.6s）
            drawImg(origImg, 1, 1 + t * 0.03);
          } else if (t < 0.6) {
            // Phase 2: 交叉淡入淡出（0.6s-1.8s）
            const fade = (t - 0.2) / 0.4;
            drawImg(origImg, 1 - fade, 1.03);
            drawImg(effImg, fade, 1.03);
          } else {
            // Phase 3: 特效图弹跳亮相（1.8s-3s）
            const showT = (t - 0.6) / 0.4;
            const bounce = 1 - 0.06 * Math.sin(showT * Math.PI) * (1 - showT);
            drawImg(effImg, 1, bounce);
          }

          frame++;
          if (frame < totalFrames) {
            setTimeout(tick, 1000 / fps);
          } else {
            recorder.stop();
          }
        }
        tick();
      });

      const blob = new Blob(chunks, { type: 'video/webm' });
      setVideoBlobUrl(URL.createObjectURL(blob));
    } catch (e: any) {
      setError('视频生成失败: ' + (e?.message || ''));
    }
    setGeneratingVideo(false);
  }, [preview, originalFrame]);

  function loadImage(src: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    });
  }

  const saveVideo = useCallback(() => {
    if (!videoBlobUrl) return;
    const a = document.createElement('a');
    a.href = videoBlobUrl;
    const eff = effects.find(e => e.id === selected);
    a.download = `变身视频_${eff?.name || 'video'}_${Date.now()}.mp4`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }, [videoBlobUrl, selected, effects]);

  const selectedEffect = effects.find(e => e.id === selected);
  const selectedCount = selected ? (counts[selected] || 0) : 0;
  const currentFilter = cssFilter(filterType, filterParams);

  // 创建自定义特效
  const createEffect = useCallback(async () => {
    if (!addName.trim()) return;
    setAdding(true);
    try {
      const prompt = `将人物变成可爱的${addName}风格，卡通化`;
      const data = await apiPost<{ id: string; ok: boolean }>('/api/effects', {
        name: addName.trim(),
        description: addDesc.trim() || `${addName}变身效果`,
        prompt_template: prompt,
        model: 'seedream-5.0-lite',
        effect_type: 'IMAGE',
      });
      // 如果有上传图片，上传示例图
      if (addImageB64 && data.id) {
        const token = await getToken();
        await fetch(API(`/api/effects/${data.id}/image`), {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ image: addImageB64 }),
        });
      }
      // 刷新列表
      fetch(API('/api/effects')).then(r => r.json()).then(setEffects).catch(() => {});
      setShowAddModal(false);
      setAddName('');
      setAddDesc('');
      setAddIcon('🦕');
      setAddImageB64('');
    } catch (err: any) {
      setError(err.message || '创建失败');
    }
    setAdding(false);
  }, [addName, addDesc, addIcon, addImageB64]);

  return (
    <main className="page camera-page">
      <canvas ref={canvasRef} style={{ display: 'none' }} />
      <header className="top">
        <div className="brand"><i>📷</i>拍照变身</div>
        <div style={{ display: 'flex', gap: 8 }}>
                  {preview && <button className="link-btn" onClick={resetCamera}>← 重拍</button>}
          <button className="link-btn" onClick={() => { stopStream(); onBack(); }}>← 返回</button>
        </div>
      </header>

      <section style={{ maxWidth: 960, margin: '12px auto 0' }}>
        {/* 摄像头 + 滤镜侧栏并排 */}
        <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          {/* 预览区 */}
          <div style={{
            flex: '1 1 400px', minWidth: 280,
          }}> 
          <div style={{
            border: '4px solid var(--ink)', boxShadow: '4px 4px 0 var(--ink)',
            background: '#111', aspectRatio: '4/3', display: 'flex',
            alignItems: 'center', justifyContent: 'center',
            overflow: 'hidden', position: 'relative',
          }}>
          {cameraError ? (
            <div style={{ color: '#fff', textAlign: 'center', padding: 30 }}>
              <span style={{ fontSize: 40 }}>🚫</span>
              <p style={{ marginTop: 10, fontSize: 14, color: '#ff6b6b' }}>{cameraError}</p>
            </div>
          ) : loading ? (
            <div style={{ color: '#fff', textAlign: 'center' }}>
              <div style={{ width: 48, height: 48, border: '4px solid var(--lime)', borderTopColor: 'transparent', borderRadius: '50%', margin: '0 auto 16px', animation: 'spin 0.8s linear infinite' }} />
              <span style={{ fontSize: 16 }}>{selectedEffect ? `${selectedEffect.name} 变身中…` : 'AI 变身中…'}</span>
            </div>
          ) : preview ? (
            <div style={{ width: '100%', height: '100%', position: 'relative', overflow: 'hidden' }}>
              {/* 始终显示预览图 */}
              <img src={preview} alt="preview"
                style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }}
              />
              {/* 编码中提示 */}
              {generatingVideo && (
                <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
                  background: 'rgba(0,0,0,0.4)' }}>
                  <div style={{ textAlign: 'center' }}>
                    <div style={{ width: 40, height: 40, border: '3px solid var(--lime)', borderTopColor: 'transparent', borderRadius: '50%', margin: '0 auto 8px', animation: 'spin 0.8s linear infinite' }} />
                    <span style={{ color: '#fff', fontSize: 14, fontWeight: 700 }}>生成视频中...</span>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <>
              <video ref={videoRef} autoPlay playsInline muted
                style={{
                  width: '100%', height: '100%', objectFit: 'cover',
                  transform: facingMode === 'user' ? 'scaleX(-1)' : 'none',
                  filter: currentFilter,
                  display: cameraReady ? 'block' : 'none',
                  position: 'absolute', top: 0, left: 0,
                }}
              />
              {!cameraReady && <span style={{ color: '#888', fontSize: 16 }}>正在启动摄像头...</span>}
            </>
          )}    </div> </div>{/* 预览区结束 */}

        {/* 滤镜侧栏 */}
        {!preview && !loading && cameraReady && (
          <div style={{
            flex: '0 0 300px', minWidth: 260,
            border: '3px solid var(--ink)', boxShadow: '3px 3px 0 var(--ink)',
            background: 'var(--white)', padding: '14px 16px',
          }}>
            <p style={{ fontWeight: 900, fontSize: 13, margin: '0 0 10px', textAlign: 'center' }}>背景滤镜</p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              {(Object.keys(FILTER_NAMES) as FilterType[]).map(ft => (
                <button key={ft}
                  onClick={() => {
                    setFilterType(ft);
                    if (ft !== filterType && ft !== 'none') setFilterParams(DEFAULT_PARAMS);
                  }}
                  style={{
                    border: `2px solid ${ft === filterType ? 'var(--blue)' : 'var(--ink)'}`,
                    background: ft === filterType ? '#e0eeff' : 'var(--white)',
                    padding: '6px 10px', fontWeight: ft === filterType ? 900 : 600,
                    fontSize: 12, cursor: 'pointer', textAlign: 'left',
                    boxShadow: ft === filterType ? '2px 2px 0 var(--blue)' : '1px 1px 0 var(--ink)',
                  }}
                >
                  {FILTER_NAMES[ft]}
                </button>
              ))}
            </div>
            {/* 可调参数滑块 */}
            {filterType === 'bc' && (
              <div style={{ marginTop: 10 }}>
                <Slider label="亮度" value={filterParams.brightness} min={50} max={200}
                  onChange={v => setFilterParams(p => ({ ...p, brightness: v }))} />
                <Slider label="对比度" value={filterParams.contrast} min={50} max={200}
                  onChange={v => setFilterParams(p => ({ ...p, contrast: v }))} />
              </div>
            )}
            {filterType === 'ss' && (
              <div style={{ marginTop: 10 }}>
                <Slider label="饱和度" value={filterParams.saturation} min={0} max={300}
                  onChange={v => setFilterParams(p => ({ ...p, saturation: v }))} />
                <Slider label="锐度" value={filterParams.sharpness} min={0} max={100}
                  onChange={v => setFilterParams(p => ({ ...p, sharpness: v }))} />
              </div>
            )}
          </div>
        )}
        </div>{/* flex row 结束 */}

        {/* 规则提示 */}
        {!preview && !loading && (
          <p style={{ textAlign: 'center', marginTop: 10, fontSize: 12, color: '#888', maxWidth: 500, marginLeft: 'auto', marginRight: 'auto', lineHeight: 1.6 }}>
            完成 5 次指定特效后，将会出现一次随机变身惊喜
          </p>
        )}

        {/* 提示文字 */}
        {preview && (
          <p style={{ textAlign: 'center', marginTop: 8, fontSize: 14, fontWeight: 700 }}>
            ✅ 变身体验完成 · 可以保存或重拍
          </p>
        )}
        {error && <p style={{ textAlign: 'center', marginTop: 8, fontSize: 13, color: 'var(--orange)' }}>{error}</p>}

        {/* 拍照按钮区域 + 直接录制 */}
        {!preview && !loading && cameraReady && (
          <div style={{ display: 'flex', justifyContent: 'center', gap: 12, marginTop: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            <button className="solid-btn wide" onClick={takePhoto}
              disabled={!selected}
              style={{
                fontSize: 18, padding: '12px 40px',
                opacity: selected ? 1 : 0.5,
              }}
            >
              📸 {selected ? `拍照变身${selectedEffect ? ' → ' + selectedEffect.name : ''}` : '先选个特效'}
            </button>
            {surpriseUnlocked && (
              <button onClick={surprisePhoto}
                style={{
                  border: '3px solid var(--orange)', background: '#fff3e8',
                  padding: '10px 18px', fontWeight: 900, fontSize: 14,
                  boxShadow: '3px 3px 0 var(--orange)',
                  display: 'flex', alignItems: 'center', gap: 6,
                  cursor: 'pointer',
                }}
              >
                ✨ 惊喜随机
              </button>
            )}
            <p style={{ fontSize: 12, color: '#888', margin: 0, whiteSpace: 'nowrap' }}>
              拍照后自动加特效
            </p>
          </div>
        )}

        {/* 有预览时显示保存+重拍+生成视频 */}
        {preview && !generatingVideo && (
          <div style={{ display: 'flex', justifyContent: 'center', gap: 12, marginTop: 12, flexWrap: 'wrap' }}>
            <button className="solid-btn" onClick={saveImage} style={{ fontSize: 16, padding: '12px 28px' }}>
              保存图片
            </button>
            <button className="solid-btn" onClick={generateVideo}
              style={{ fontSize: 16, padding: '12px 28px', background: 'var(--blue)', border: '3px solid var(--ink)' }}>
              生成变身视频
            </button>
            <button className="link-btn" onClick={resetCamera} style={{ fontSize: 16, padding: '12px 28px' }}>
              重拍
            </button>
          </div>
        )}
        {/* 视频已生成 */}
        {videoBlobUrl && (
          <>
          <div style={{ marginTop: 10, textAlign: 'center' }}>
            <video src={videoBlobUrl} controls autoPlay loop
              style={{ maxWidth: '100%', maxHeight: 320, border: '4px solid var(--ink)', boxShadow: '4px 4px 0 var(--ink)' }}
            />
          </div>
          <div style={{ display: 'flex', justifyContent: 'center', gap: 12, marginTop: 12, flexWrap: 'wrap' }}>
            <button className="solid-btn" onClick={saveVideo} style={{ fontSize: 16, padding: '12px 28px' }}>
              保存视频
            </button>
            <button className="link-btn" onClick={() => { setVideoBlobUrl(null); }} style={{ fontSize: 16, padding: '12px 28px' }}>
              重新生成
            </button>
          </div>
          </>
        )}
        {/* 视频生成中动画 */}
        {generatingVideo && !videoBlobUrl && (
          <div style={{ textAlign: 'center', marginTop: 12 }}>
            <div style={{ width: 40, height: 40, border: '4px solid var(--lime)', borderTopColor: 'transparent', borderRadius: '50%', margin: '0 auto 8px', animation: 'spin 0.8s linear infinite' }} />
            <span style={{ fontSize: 14, color: '#555' }}>变身视频生成中...</span>
          </div>
        )}

        {/* 特效选择 */}
        <div style={{ marginTop: preview ? 20 : 16 }}>
          <div className="section-title" style={{ marginBottom: 10 }}>
            <h2 style={{ fontSize: 16 }}>选择变身体验</h2>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 13, color: '#888' }}>{effects.length} 种</span>
              {selected && (
                <span style={{ fontSize: 12, color: '#888', background: '#eee', padding: '2px 8px', borderRadius: 4 }}>
                  已拍 {selectedCount} 次
                </span>
              )}
              <button onClick={clearCounts} style={{ fontSize: 11, color: '#aaa', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
                重置
              </button>
            </div>
          </div>
          <div style={{
            display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(100px, 1fr))',
            gap: 8,
          }}>
            {effects.map(ef => {
              const isActive = selected === ef.id;
              const icon = EFFECT_ICONS[ef.name] || '✦';
              const count = counts[ef.id] || 0;
              const isMaxed = count >= 5;
              return (
                <button key={ef.id}
                  onClick={() => { setSelected(ef.id); setError(''); }}
                  style={{
                    border: `3px solid ${isActive ? 'var(--lime)' : isMaxed ? 'var(--orange)' : 'var(--ink)'}`,
                    background: isActive ? '#eaffcc' : 'var(--white)',
                    boxShadow: isActive ? '3px 3px 0 var(--lime)' : '2px 2px 0 var(--ink)',
                    padding: 8, borderRadius: 0, cursor: 'pointer',
                    textAlign: 'center', transition: 'all 0.1s',
                    position: 'relative',
                  }}
                >
                  {count > 0 && (
                    <span style={{
                      position: 'absolute', top: -6, right: -6,
                      background: isMaxed ? 'var(--orange)' : '#888',
                      color: '#fff', fontSize: 10, fontWeight: 900,
                      width: 18, height: 18, borderRadius: '50%',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      lineHeight: 1,
                    }}>
                      {count >= 5 ? '✓' : count}
                    </span>
                  )}
                  {ef.image_url ? (
                    <div style={{ height: 50, overflow: 'hidden', marginBottom: 4, border: '1px solid #ddd' }}>
                      <img src={ef.image_url} alt={ef.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                    </div>
                  ) : (
                    <span style={{ fontSize: 24, display: 'block', marginBottom: 2 }}>{icon}</span>
                  )}
                  <span style={{ fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap' }}>{ef.name}</span>
                  {isMaxed && <span style={{ fontSize: 9, color: 'var(--orange)', display: 'block' }}>✨已满</span>}
                </button>
              );
            })}
            {/* + 添加按钮 */}
            <button onClick={() => { setShowAddModal(true); }}
              style={{
                border: '3px dashed var(--ink)',
                background: 'var(--white)', opacity: 0.7,
                padding: 8, borderRadius: 0, cursor: 'pointer',
                textAlign: 'center', display: 'flex',
                flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                gap: 4, minHeight: 78,
                transition: 'opacity 0.15s',
              }}
              onMouseEnter={e => (e.currentTarget.style.opacity = '1')}
              onMouseLeave={e => (e.currentTarget.style.opacity = '0.7')}
            >
              <span style={{ fontSize: 28, lineHeight: 1, color: '#888' }}>+</span>
              <span style={{ fontSize: 10, color: '#888', fontWeight: 700 }}>自定义</span>
            </button>
          </div>
        </div>

        {/* 惊喜解锁提示 */}
        {surpriseUnlocked && !preview && (
          <p style={{ textAlign: 'center', marginTop: 8, fontSize: 12, color: 'var(--orange)' }}>
            ✨ 有特效已满 5 次，解锁了惊喜随机！点上方橙色按钮试试手气
          </p>
        )}

        {/* 切换摄像头 */}
        {!preview && !loading && cameraReady && (
          <div style={{ display: 'flex', justifyContent: 'center', marginTop: 12 }}>
            <button className="solid-btn" onClick={switchCamera} style={{ fontSize: 13, padding: '10px 16px' }}>
              🔄 切换摄像头
            </button>
          </div>
        )}
      </section>

      {/* 添加特效弹窗 */}
      {showAddModal && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 1000,
          background: 'rgba(0,0,0,0.4)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          padding: 20,
        }} onClick={() => { if (!adding) setShowAddModal(false); }}>
          <div style={{
            background: 'var(--white)', border: '4px solid var(--ink)',
            boxShadow: '8px 8px 0 var(--ink)',
            padding: '28px 32px', maxWidth: 400, width: '100%',
          }} onClick={e => e.stopPropagation()}>
            <h2 style={{ fontSize: 18, margin: '0 0 18px' }}>自定义变身</h2>

            <label style={{ display: 'block', fontSize: 12, fontWeight: 700, marginBottom: 4 }}>名称 *</label>
            <input value={addName} onChange={e => setAddName(e.target.value)}
              placeholder="例：小恐龙"
              style={{
                width: '100%', border: '2px solid var(--ink)', padding: '8px 10px',
                fontSize: 14, marginBottom: 12,
              }}
            />

            <label style={{ display: 'block', fontSize: 12, fontWeight: 700, marginBottom: 4 }}>描述</label>
            <input value={addDesc} onChange={e => setAddDesc(e.target.value)}
              placeholder="例：绿色的小恐龙，可爱风格"
              style={{
                width: '100%', border: '2px solid var(--ink)', padding: '8px 10px',
                fontSize: 14, marginBottom: 12,
              }}
            />

            <label style={{ display: 'block', fontSize: 12, fontWeight: 700, marginBottom: 4 }}>示例图（可选）</label>
            <input type="file" accept="image/*"
              onChange={e => {
                const file = e.target.files?.[0];
                if (!file) return;
                const reader = new FileReader();
                reader.onload = () => setAddImageB64(reader.result as string);
                reader.readAsDataURL(file);
              }}
              style={{ width: '100%', fontSize: 12, marginBottom: 12 }}
            />
            {addImageB64 && (
              <div style={{ marginBottom: 12 }}>
                <img src={addImageB64} alt="preview"
                  style={{ width: 80, height: 80, objectFit: 'cover', border: '2px solid var(--ink)' }}
                />
              </div>
            )}

            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 6 }}>
              <button className="link-btn" onClick={() => setShowAddModal(false)} disabled={adding}
                style={{ fontSize: 13, padding: '8px 16px' }}>
                取消
              </button>
              <button className="solid-btn" onClick={createEffect} disabled={adding || !addName.trim()}
                style={{ fontSize: 13, padding: '8px 16px' }}>
                {adding ? '创建中...' : '创建'}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}