import { Injectable } from '@nestjs/common';

@Injectable()
export class AppService {
  /**
   * Página de aterrizaje tras confirmar el email (Supabase redirige acá con el
   * Site URL actual). Es una solución temporal: el aterrizaje definitivo en el
   * frontend se resuelve en ENG-44.
   */
  getConfirmationPage(): string {
    const webUrl = process.env.WEB_ORIGIN ?? 'http://localhost:5173';
    return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>MediConnect — Email confirmado</title>
<style>
  :root { --brand:#14b8a6; --brand-deep:#0b4f6c; --ink:#1e293b; --muted:#64748b; }
  * { box-sizing:border-box; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
    font-family:system-ui,'Segoe UI',Roboto,sans-serif; color:var(--ink);
    background:linear-gradient(135deg,#e8f4f4,#f4f8fa); padding:24px; }
  .card { background:#fff; border:1px solid #e2e8f0; border-radius:22px; padding:48px 40px;
    max-width:440px; width:100%; text-align:center; box-shadow:0 16px 40px rgba(2,60,80,.10); }
  .brand { display:inline-flex; align-items:center; gap:8px; margin-bottom:28px;
    font-weight:700; color:var(--brand-deep); font-size:18px; }
  .badge { width:76px; height:76px; margin:0 auto 22px; border-radius:50%; background:var(--brand);
    display:flex; align-items:center; justify-content:center; box-shadow:0 8px 20px rgba(20,184,166,.35); }
  h1 { font-size:26px; margin:0 0 10px; color:var(--brand-deep); }
  p { margin:0 0 30px; color:var(--muted); line-height:1.55; }
  .btn { display:inline-block; background:var(--brand); color:#fff; text-decoration:none;
    font-weight:600; padding:13px 30px; border-radius:11px; transition:background .15s; }
  .btn:hover { background:#0e7c7b; }
</style>
</head>
<body>
  <div class="card">
    <span class="brand">
      <svg width="26" height="26" viewBox="0 0 24 24" fill="#14b8a6" aria-hidden="true">
        <path d="M12 21s-7.5-4.6-10-9.3C.6 8.3 2.3 5 5.5 5c2 0 3.3 1.2 4.5 2.6C11.2 6.2 12.5 5 14.5 5 17.7 5 19.4 8.3 22 11.7 19.5 16.4 12 21 12 21z"/>
      </svg>
      MediConnect
    </span>
    <div class="badge">
      <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#fff"
        stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M20 6 9 17l-5-5"/>
      </svg>
    </div>
    <h1>¡Email confirmado!</h1>
    <p>Tu cuenta de MediConnect ya está activa. Ya podés iniciar sesión y empezar a cuidar tu salud.</p>
    <a class="btn" href="${webUrl}/ingresar">Ir a MediConnect</a>
  </div>
</body>
</html>`;
  }
}
