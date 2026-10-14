# Templates de mail de Supabase Auth

Supabase no los lee de acá: se pegan a mano en el dashboard, en
**Authentication → Emails**. Este directorio es la copia versionada, para que
un cambio quede revisado en un PR y no se pierda si alguien toca el dashboard.

| Template en el dashboard | Archivo | Asunto |
|---|---|---|
| Confirm signup | `confirm-signup.html` | Confirmá tu cuenta de MediConnect |
| Reset password | `reset-password.html` | Restablecé tu contraseña de MediConnect |

- **Reset password** tiene que mantener el enlace
  `{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=recovery`: es lo que lee
  `/restablecer-contrasena` en la web (ENG-142). Con `{{ .ConfirmationURL }}`
  el flujo se rompe.
- El logo se carga de `https://mediconnect-web-bigz.onrender.com/logo-horizontal-light.png`.
  Si cambia la URL de la web, hay que actualizarlo en los dos archivos.
- Los estilos van inline y el layout en tablas: es lo único que respetan
  Gmail y Outlook.
