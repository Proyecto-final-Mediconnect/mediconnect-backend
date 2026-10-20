-- ENG-140 (review de la PR #63): desde dónde se aceptaron los textos legales.
--
-- Además de quién, qué versión y cuándo, cada aceptación guarda la IP real del
-- cliente (`CF-Connecting-IP`, ENG-84), el user-agent y el canal (`REGISTER` al
-- crear la cuenta, `REACCEPT` desde `POST /me/legal-acceptance`). Ante una
-- disputa es lo que permite reconstruir el contexto. `ip` y `user_agent` son
-- nullable: si no se pueden determinar, la aceptación se guarda igual.
--
-- Va en una migración aparte y no editando `20261013130000_eng140_legal_acceptances`
-- porque esa ya está aplicada en la base compartida: cambiarla rompe el checksum
-- y `migrate deploy` no la vuelve a correr, así que las columnas no existirían.
--
-- `ADD COLUMN ... DEFAULT` es DDL: no dispara el trigger append-only de UPDATE
-- (y en Postgres 11+ no reescribe la tabla). Las filas que ya existían quedan
-- con `source = 'REGISTER'` —hasta acá la única forma de aceptar era al
-- registrarse— y sin IP ni user-agent, que en su momento no se guardaron. Después
-- se saca el default para que el backend siempre informe el canal.
--
-- Supresión de cuentas (Ley 25.326 art. 16). Con RESTRICT + el trigger
-- append-only, una cuenta con aceptación no se puede borrar, ni con
-- `auth.admin.deleteUser` (la cascada `auth.users -> profiles` choca con la FK).
-- Eso incluye cuentas que nunca confirmaron el email, porque la aceptación se
-- guarda en el `signUp`. El procedimiento ante un pedido de supresión es:
--   1. Anonimizar el perfil: reemplazar email y datos personales de `profiles`,
--      `patients`/`professionals` por valores no identificatorios, y bloquear
--      el login en Supabase Auth (ban o cambio de email/contraseña aleatorios)
--      en lugar de borrar el usuario.
--   2. Conservar las filas de `legal_acceptances`: son la prueba de que el
--      tratamiento previo tuvo consentimiento (art. 16 inc. 5: la supresión no
--      procede cuando hay una obligación legal de conservar los datos).
-- Pendiente de decisión del equipo: mantener esto o guardar la aceptación recién
-- al confirmar el email / primer login, para que no queden filas indelebles de
-- cuentas que nunca se usaron.

-- CreateEnum
--;;
CREATE TYPE "legal_acceptance_source" AS ENUM ('REGISTER', 'REACCEPT');

-- AlterTable
--;;
ALTER TABLE "legal_acceptances"
  ADD COLUMN "source" "legal_acceptance_source" NOT NULL DEFAULT 'REGISTER',
  ADD COLUMN "ip" INET,
  ADD COLUMN "user_agent" VARCHAR(512);
--;;
ALTER TABLE "legal_acceptances" ALTER COLUMN "source" DROP DEFAULT;
