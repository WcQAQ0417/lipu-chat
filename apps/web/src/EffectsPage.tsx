import { useState, useCallback, useEffect } from 'react';

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

const API = (path: string) => `${import.meta.env.VITE_API_URL || ''}${path}`;
const TOKEN_KEY='***';

async function getToken(): Promise<string> {
  let token = localStorage.getItem(TOKEN_KEY);
  if (!token) {
    const res = await fetch(API('/api/session'), { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } });
    const data = await res.json();
    token = data.token;
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

/** 压缩图片到合适尺寸 */
function compressImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const MAX = 600;
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        try {
          let { width, height } = img;
          if (width > MAX || height > MAX) {
            const ratio = Math.min(MAX / width, MAX / height);
            width = Math.round(width * ratio);
            height = Math.round(height * ratio);
          }
          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext('2d')!;
          ctx.drawImage(img, 0, 0, width, height);
          resolve(canvas.toDataURL('image/jpeg', 0.8));
        } catch (e) { reject(e); }
      };
      img.onerror = reject;
      img.src = reader.result as string;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/** 特效图标映射 */
const EFFECT_ICONS: Record<string, string> = {
  '奶龙': '🦕',
  '奶蛙': '🐸',
  '猫猫': '🐱',
  '狗狗': '🐶',
  '熊猫': '🐼',
  '兔子': '🐰',
  '水獭': '🦦',
  '企鹅': '🐧',
  '考拉': '🐨',
  '小狮子': '🦁',
};

export function EffectsPage({ onBack, onManage }: { onBack: () => void; onManage: () => void }) {
  const [effects, setEffects] = useState<Effect[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [image, setImage] = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);
  const [result, setResult] = useState<ProcessResult | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    fetch(API('/api/effects')).then(r => r.json()).then(setEffects).catch(() => {});
  }, []);

  const handleImage = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 20 * 1024 * 1024) {
      setError('图片太大，请选择 20MB 以内的图片');
      return;
    }
    try {
      const compressed = await compressImage(file);
      setImage(compressed);
      setError('');
    } catch {
      setError('图片处理失败，请换一张图片试试');
    }
  }, []);

  const process = useCallback(async () => {
    if (!selected) return;
    setProcessing(true);
    setError('');
    setResult(null);
    try {
      const data = await apiPost<ProcessResult>('/api/effects/process', { effect_id: selected, image: image || undefined });
      setResult(data);
    } catch (err: any) {
      setError(err.message || '处理失败');
    }
    setProcessing(false);
  }, [selected, image]);

  return (
    <main className="page effects-page">
      <header className="top">
        <div className="brand"><i>✦</i>图片特效</div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="link-btn" onClick={onManage}>管理 ↗</button>
          <button className="link-btn" onClick={onBack}>← 返回大厅</button>
        </div>
      </header>

      <section className="effects-section" style={{ maxWidth: 900, margin: '40px auto 0' }}>
        <div className="section-title">
          <h2>选择特效</h2>
          <span>{effects.length} 种变身效果</span>
        </div>
        <div className="effects-grid" style={{
          display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
          gap: 16, marginTop: 20,
        }}>
          {effects.map(ef => {
            const isActive = selected === ef.id;
            const icon = EFFECT_ICONS[ef.name] || '✦';
            return (
              <button
                key={ef.id}
                onClick={() => setSelected(ef.id)}
                style={{
                  border: `3px solid ${isActive ? 'var(--lime)' : 'var(--ink)'}`,
                  background: isActive ? '#eaffcc' : 'var(--white)',
                  boxShadow: isActive ? '6px 6px 0 var(--lime)' : '3px 3px 0 var(--ink)',
                  padding: 0, borderRadius: 0, cursor: 'pointer',
                  textAlign: 'left', transition: 'all 0.15s',
                  overflow: 'hidden',
                }}
              >
                {/* 示例图 */}
                {ef.image_url ? (
                  <div style={{ height: 130, overflow: 'hidden', background: '#f0ede6' }}>
                    <img src={ef.image_url} alt={ef.name}
                      style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                    />
                  </div>
                ) : (
                  <div style={{ height: 100, display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#f0ede6' }}>
                    <span style={{ fontSize: 40, opacity: 0.3 }}>{icon}</span>
                  </div>
                )}
                <div style={{ padding: '10px 14px 14px' }}>
                  <strong style={{ fontSize: 16, fontWeight: 900 }}>{ef.name}</strong>
                  <p style={{ margin: '4px 0 0', fontSize: 12, color: '#666', lineHeight: 1.3 }}>{ef.description}</p>
                </div>
              </button>
            );
          })}
        </div>
      </section>

      <section className="upload-section" style={{ maxWidth: 900, margin: '32px auto 0' }}>
        <div className="section-title">
          <h2>上传照片</h2>
          <span>AI 会根据你的照片生成对应风格</span>
        </div>
        <div style={{ marginTop: 16 }}>
          <div style={{
            border: `3px dashed var(--ink)`, padding: 24,
            background: 'var(--white)', boxShadow: '3px 3px 0 #111',
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12,
          }}>
            {image ? (
              <img src={image} alt="preview"
                style={{ maxWidth: 260, maxHeight: 220, borderRadius: 0, border: '3px solid var(--ink)' }}
              />
            ) : (
              <span style={{ fontSize: 48, opacity: 0.3 }}>📷</span>
            )}
            <label className="solid-btn" style={{ display: 'inline-block', cursor: 'pointer' }}>
              {image ? '换一张' : '选择照片'}
              <input type="file" accept="image/*" onChange={handleImage} style={{ display: 'none' }} />
            </label>
            <p style={{ margin: 0, fontSize: 12, color: '#888' }}>
              建议上传清晰的正面照片，效果更好 · 图片自动压缩加速生成
            </p>
          </div>
        </div>
      </section>

      <div style={{ maxWidth: 900, margin: '28px auto 0', textAlign: 'right' }}>
        <button
          onClick={process}
          disabled={!selected || processing}
          className="solid-btn wide"
          style={{
            opacity: (!selected || processing) ? 0.5 : 1,
            fontSize: 18, padding: '16px 0',
          }}
        >
          {processing ? '✨ 正在生成...' : '✦ 开始施法'}
        </button>
        {error && <p style={{ color: 'var(--orange)', marginTop: 10, fontSize: 14 }}>{error}</p>}
      </div>

      {result && (
        <section className="result-section" style={{ maxWidth: 900, margin: '32px auto 60px' }}>
          <div className="section-title">
            <h2>生成结果</h2>
            <span>{result.description}</span>
          </div>
          <div style={{ marginTop: 16, border: `3px solid var(--ink)`, boxShadow: '6px 6px 0 var(--ink)', background: 'var(--white)' }}>
            <img
              src={result.result}
              alt="result"
              style={{ width: '100%', maxHeight: 500, objectFit: 'contain', display: 'block' }}
            />
          </div>
        </section>
      )}
    </main>
  );
}

export function EffectsManagePage({ onBack }: { onBack: () => void }) {
  const [effects, setEffects] = useState<Effect[]>([]);
  const [uploadingId, setUploadingId] = useState<string | null>(null);
  const [msg, setMsg] = useState('');
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    fetch(API('/api/effects')).then(r => r.json()).then(setEffects).catch(() => {});
  }, []);

  async function uploadSample(effectId: string, file: File) {
    if (file.size > 20 * 1024 * 1024) { setMsg('图片太大'); return; }
    setUploadingId(effectId);
    setMsg('');
    try {
      const compressed = await compressImage(file);
      const result = await apiPost<{ ok: boolean; image_url: string }>(`/api/effects/${effectId}/image`, { image: compressed });
      setEffects(prev => prev.map(ef => ef.id === effectId ? { ...ef, image_url: result.image_url } : ef));
      setMsg('上传成功！');
    } catch (err: any) {
      setMsg(err.message || '上传失败');
    }
    setUploadingId(null);
  }

  async function createEffect() {
    if (!newName.trim() || !newDesc.trim()) { setMsg('请填写名称和描述'); return; }
    setCreating(true);
    setMsg('');
    try {
      // 自动生成 prompt_template
      const prompt = `将参考图的内容转化为可爱的卡通${newName.trim()}风格——动漫风格，高质量，明亮色彩。`;
      await apiPost('/api/effects', {
        name: newName.trim(),
        description: newDesc.trim(),
        prompt_template: prompt,
      });
      setNewName('');
      setNewDesc('');
      setMsg('创建成功！');
      // 刷新列表
      const res = await fetch(API('/api/effects'));
      setEffects(await res.json());
    } catch (err: any) {
      setMsg(err.message || '创建失败');
    }
    setCreating(false);
  }

  return (
    <main className="page effects-page">
      <header className="top">
        <div className="brand"><i>⚙</i>特效管理</div>
        <button className="link-btn" onClick={onBack}>← 返回</button>
      </header>

      {msg && <div style={{ maxWidth: 900, margin: '16px auto 0', padding: '8px 16px', background: 'var(--lime)', border: '3px solid var(--ink)', fontWeight: 700, fontSize: 13 }}>{msg}</div>}

      {/* 新建特效 */}
      <section style={{ maxWidth: 900, margin: '24px auto 0' }}>
        <div className="section-title">
          <h2>🆕 新建特效</h2>
          <span>输入名称和描述，自动生成 Prompt</span>
        </div>
        <div style={{ marginTop: 12, border: '3px solid var(--ink)', background: 'var(--white)', boxShadow: '3px 3px 0 #111', padding: 20 }}>
          <div style={{ display: 'flex', gap: 12, alignItems: 'end', flexWrap: 'wrap' }}>
            <div style={{ flex: '1 1 180px' }}>
              <label style={{ fontSize: 12, fontWeight: 700, display: 'block', marginBottom: 4 }}>名称</label>
              <input value={newName} onChange={e => setNewName(e.target.value)} placeholder="如：小猫咪"
                style={{ width: '100%', padding: '8px 12px', border: '2px solid var(--ink)', fontSize: 14, outline: 'none', boxShadow: '2px 2px 0 #111' }}
              />
            </div>
            <div style={{ flex: '2 1 280px' }}>
              <label style={{ fontSize: 12, fontWeight: 700, display: 'block', marginBottom: 4 }}>描述</label>
              <input value={newDesc} onChange={e => setNewDesc(e.target.value)} placeholder="如：变成可爱的卡通猫咪"
                style={{ width: '100%', padding: '8px 12px', border: '2px solid var(--ink)', fontSize: 14, outline: 'none', boxShadow: '2px 2px 0 #111' }}
              />
            </div>
            <button onClick={createEffect} disabled={creating}
              className="solid-btn" style={{ flexShrink: 0, cursor: creating ? 'wait' : 'pointer' }}
            >
              {creating ? '创建中...' : '✦ 创建'}
            </button>
          </div>
        </div>
      </section>

      {/* 特效列表 */}
      <section style={{ maxWidth: 900, margin: '24px auto 40px' }}>
        <div className="section-title">
          <h2>特效列表</h2>
          <span>点击上传示例图</span>
        </div>
        <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
          {effects.map(ef => {
            const icon = EFFECT_ICONS[ef.name] || '✦';
            const isUploading = uploadingId === ef.id;
            return (
              <div key={ef.id} style={{
                display: 'flex', alignItems: 'center', gap: 16,
                border: '3px solid var(--ink)', background: 'var(--white)',
                boxShadow: '3px 3px 0 #111', padding: 12,
              }}>
                <div style={{
                  width: 80, height: 80, flexShrink: 0,
                  background: '#f0ede6', display: 'flex',
                  alignItems: 'center', justifyContent: 'center',
                  border: '2px solid #111', overflow: 'hidden',
                }}>
                  {ef.image_url ? (
                    <img src={ef.image_url} alt={ef.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                  ) : (
                    <span style={{ fontSize: 32, opacity: 0.4 }}>{icon}</span>
                  )}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <strong style={{ fontSize: 16 }}>{ef.name}</strong>
                  <p style={{ margin: '2px 0', fontSize: 12, color: '#666' }}>{ef.description}</p>
                </div>
                <label style={{
                  padding: '8px 14px', border: '2px solid var(--ink)',
                  background: isUploading ? '#ddd' : 'var(--lime)',
                  fontWeight: 700, cursor: isUploading ? 'wait' : 'pointer',
                  boxShadow: '2px 2px 0 #111', whiteSpace: 'nowrap',
                }}>
                  {isUploading ? '上传中...' : '📷 上传示例图'}
                  <input type="file" accept="image/*" style={{ display: 'none' }}
                    disabled={isUploading}
                    onChange={async e => {
                      const file = e.target.files?.[0];
                      if (file) await uploadSample(ef.id, file);
                    }}
                  />
                </label>
              </div>
            );
          })}
        </div>
      </section>
    </main>
  );
}