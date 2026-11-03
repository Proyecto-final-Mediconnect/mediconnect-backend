# Rol con permisos mínimos para el backend (ENG-138, parte 1)

## Por qué

Hasta ahora el backend se conecta a Supabase como `postgres`, que es **dueño de
todas las tablas**. Un dueño puede hacer `ALTER TABLE ... DISABLE TRIGGER`, así
que una inyección SQL o un error en una consulta cruda podría apagar los
triggers que hacen inalterable la historia clínica (ENG-57, ENG-126), la
auditoría (ENG-87) y la constancia de consentimiento (ENG-140), y después
reescribir esas filas.

Con `mediconnect_backend` el backend:

- **no es dueño de nada**: no puede desactivar triggers, ni hacer DDL, ni `TRUNCATE`;
- **no tiene `UPDATE` ni `DELETE`** sobre las tablas append-only
  (`clinical_record_entries`, `audit_logs`, `medipass_access_logs`,
  `legal_acceptances`, `integrity_checks`). El permiso falta antes de que el
  trigger tenga que actuar;
- sobre `patient_documents` tiene `UPDATE` (marcar el retiro) pero no `DELETE`.

**Lo que todavía no hace (parte 2):** el rol tiene `BYPASSRLS`. Para que RLS
filtre cada consulta por usuario hay que pasarle la identidad a la base en cada
transacción y escribir políticas por rol. Es un ticket aparte.

## Qué rol se usa para qué

| Rol | Dónde | Para qué |
|---|---|---|
| `postgres` | Secret `DATABASE_URL` de GitHub Actions | `prisma migrate deploy` en el deploy, el seed y el job de integridad. Es el dueño de las tablas. |
| `mediconnect_backend` | `DATABASE_URL` en Render | El backend en runtime. Solo filas, nunca estructura. |

Las migraciones no cambian: siguen corriendo desde GitHub Actions como
`postgres` (ver "Deployment" en el README), así que cambiar la URL de Render no
las afecta.

## Cómo ponerlo en marcha

Son cinco pasos. Hacelos en un momento sin demo: si algo falla, la vuelta atrás
es inmediata (paso 5).

1. **Correr el script.** En Supabase → SQL Editor, pegar y ejecutar
   `prisma/sql/eng138-rol-backend.sql` entero. Es idempotente: correrlo dos
   veces no rompe nada.

2. **Ponerle contraseña.** En el mismo SQL Editor, con una contraseña larga y
   aleatoria (por ejemplo, `openssl rand -base64 32`):

   ```sql
   alter role mediconnect_backend password '<la contraseña>';
   ```

   Guardala en el gestor de contraseñas del equipo. No va al repo.

3. **Armar la connection string.** Es la misma del Session pooler que usa hoy
   Render (ver "Conexión" en el README), cambiando el usuario y la contraseña.
   El usuario lleva el project ref, igual que el de `postgres`:

   ```
   postgresql://mediconnect_backend.<project-ref>:<contraseña>@aws-1-sa-east-1.pooler.supabase.com:5432/postgres?schema=public
   ```

4. **Cambiarla en Render.** Environment → `DATABASE_URL` → la nueva → *Save*.
   Render reinicia el servicio. Después verificá, en este orden:
   - `GET /health` devuelve 200;
   - ingresar como paciente y ver los turnos;
   - abrir un MediPass desde otra pestaña (escribe sesión, bitácora y aviso);
   - un profesional agrega una entrada de historia clínica (escribe la cadena
     de hash y el snapshot de la cabeza).

   Si todo anda, listo. Si algo da `permission denied for table ...`, el
   mensaje dice qué tabla falta: es un `GRANT` para sumar al script (y al test
   `test/backend-role.integration.spec.ts`, que tiene la lista de escrituras).

5. **Vuelta atrás.** Volver a poner en Render la `DATABASE_URL` anterior (la de
   `postgres`). No hay nada que deshacer en la base: el rol puede quedar creado.

## Cuando se agrega una tabla

Las tablas que cree una migración nacen con `SELECT, INSERT, UPDATE, DELETE`
para el rol, por los *default privileges* del script. **Si la tabla nueva es
append-only, su migración tiene que revocar `UPDATE` y `DELETE`**, como hace el
script con las existentes, y sumarla a `APPEND_ONLY` en el test.
