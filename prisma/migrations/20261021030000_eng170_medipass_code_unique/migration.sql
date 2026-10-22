-- ENG-170 · Hallazgo 1 de ENG-105: unicidad del código MediPass
--
-- `medipass_codes` no tenía ninguna restricción de unicidad sobre `code`, y
-- `getMyCode` genera el código sin verificar colisiones. El canje busca así:
--
--     findFirst({ where: { code, expires_at: { gt: ahora } },
--                 orderBy: { expires_at: 'desc' } })
--
-- Si dos pacientes tuvieran el mismo código vigente, eso devuelve **uno** de los
-- dos, y el médico que escaneó el QR de un paciente recibe el bloque vital del
-- otro: alergias, medicación y grupo sanguíneo de otra persona, en una urgencia,
-- sin ninguna señal de que algo salió mal.
--
-- La probabilidad es remota —1,3 × 10⁻⁶ con mil códigos vigentes al mismo
-- tiempo, por cumpleaños sobre 28^8— y a la escala de este proyecto no va a
-- pasar. Se cierra igual por la asimetría: el daño es el peor que el sistema
-- puede producir y el arreglo cuesta esto.
--
-- Las cuentas están en `mediconnect-docs/documentacion-tecnica/spikes/ENG-105-medipass-cripto.md`.
--
-- ## Por qué la unicidad es sobre `code` a secas y no sobre "los vigentes"
--
-- Lo que hace falta garantizar es que no haya dos códigos **vigentes** iguales,
-- que sería un índice único parcial con `where expires_at > now()`. No se puede:
-- `now()` no es inmutable y Postgres no la acepta en el predicado de un índice.
--
-- Así que la unicidad va sobre toda la vida de la fila, que es una condición más
-- fuerte y suficiente. El costo es que un código no se puede reutilizar nunca,
-- ni siquiera años después de vencido. Con 3,78 × 10^11 combinaciones y el
-- reintento del service eso no es un problema práctico: con un millón de filas
-- acumuladas, la probabilidad de que una generación colisione es 2,6 × 10⁻⁶.
--
-- Las líneas `--;;` son comentarios SQL que Prisma ignora: marcan el corte entre
-- sentencias para que el spec de integración pueda cargar el archivo statement
-- por statement.

-- ---------------------------------------------------------------------------
-- 1) Deduplicar antes de crear el índice
-- ---------------------------------------------------------------------------
-- Un `create unique index` a secas **falla** si la tabla ya tiene dos filas con
-- el mismo código, y entonces la migración entera no aplica. No es hipotético
-- que no sepamos: la migración de #68 nunca corrió contra una base real, así que
-- nadie vio todavía esta tabla con datos de producción.
--
-- Borrar un código es seguro: son tokens efímeros de cinco minutos, no datos del
-- paciente, y el próximo `GET /medipass/me` genera el siguiente.
--
-- **Pero `medipass_sessions.medipass_code_id` tiene `ON DELETE RESTRICT`**, así
-- que una fila con sesiones colgadas no se puede borrar. Eso fija el criterio: de
-- cada grupo de repetidos sobrevive **la que tenga sesiones**, y solo entre las
-- que no tienen ninguna se desempata por la más nueva. Al revés —quedándose
-- siempre con la más nueva— un grupo de dos donde la vieja tiene sesiones y la
-- nueva no plantaría la migración sin necesidad, porque ninguna de las dos
-- calificaría para el borrado.
--
-- Lo que **no** se hace es borrar en cascada: el rastro de un acceso que alguien
-- tuvo a una ficha clínica no se tira para que aplique una migración. Si quedan
-- dos filas con sesiones, el paso 2 planta esto con un mensaje que dice qué
-- revisar.
--;;
delete from public.medipass_codes c
where not exists (
        select 1
        from public.medipass_sessions s
        where s.medipass_code_id = c.id
      )
  and exists (
        select 1
        from public.medipass_codes otro
        where otro.code = c.code
          and otro.id <> c.id
          and (
            -- Otra fila del grupo tiene sesiones: esa es la que se queda.
            exists (
              select 1
              from public.medipass_sessions s2
              where s2.medipass_code_id = otro.id
            )
            -- O ninguna tiene sesiones y esta no es la más nueva.
            or (otro.created_at, otro.id) > (c.created_at, c.id)
          )
      );

-- ---------------------------------------------------------------------------
-- 2) Fallar con un mensaje útil si quedó alguna duplicación
-- ---------------------------------------------------------------------------
-- Si acá queda un duplicado es porque las dos filas tienen sesiones asociadas,
-- es decir: la colisión **ocurrió y las dos se usaron**. Eso no se resuelve
-- borrando a ciegas en una migración; hay que mirar qué pasó, porque significa
-- que alguien vio la ficha de otro.
--
-- El `raise` deja la migración sin aplicar y dice exactamente qué revisar, en
-- lugar del `23505` pelado que daría el índice.
--;;
do $$
declare
  repetidos int;
begin
  select count(*) into repetidos
  from (
    select code
    from public.medipass_codes
    group by code
    having count(*) > 1
  ) d;

  if repetidos > 0 then
    raise exception
      'ENG-170: quedan % codigos de MediPass duplicados con sesiones asociadas. '
      'Revisar manualmente: una colision que se uso significa que un consultante '
      'pudo haber accedido a la ficha de otro paciente. '
      'Consulta: select code, count(*) from medipass_codes group by code having count(*) > 1;',
      repetidos;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 3) La unicidad
-- ---------------------------------------------------------------------------
-- A partir de acá, una colisión deja de ser silenciosa: la generación recibe un
-- `23505` (`P2002` en Prisma) y `MediPassService.getMyCode` reintenta con otro
-- código, igual que `ClinicalRecordsService` ante una colisión de
-- `sequence_number` al apendizar en la cadena de hash.
--
-- El índice de #68 sobre `(code, expires_at)` se mantiene: lo usa el canje, que
-- filtra por las dos columnas. Este índice único es sobre `code` solo y no lo
-- reemplaza.
--;;
create unique index if not exists "medipass_codes_code_key"
  on public.medipass_codes ("code");
