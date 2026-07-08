-- EP-02..EP-10 — Esquema completo (catálogo, agenda, pagos, consulta, HC, IA,
-- comunicación, MediPass, auditoría). Modelo canónico:
-- mediconnect-docs/modelo-de-datos/esquema.md y der.md.
--
-- Crea tablas, enums, índices, FKs y CHECKs. NO incluye políticas RLS ni los
-- triggers de append-only/cadena de hash de la HC: esos se agregan por épica al
-- implementar cada feature (mismo criterio que EP-01, que puso el esquema en una
-- migración y la RLS en otra).

-- CreateEnum
CREATE TYPE "appointment_status" AS ENUM ('RESERVADO_SIN_PAGAR', 'CONFIRMADO', 'CANCELADO', 'COMPLETADO', 'NO_ASISTIO', 'LIBERADO');
CREATE TYPE "video_session_status" AS ENUM ('CREADA', 'EN_CURSO', 'FINALIZADA');
CREATE TYPE "payment_status" AS ENUM ('PENDIENTE', 'APROBADO', 'RECHAZADO', 'REEMBOLSADO');
CREATE TYPE "refund_status" AS ENUM ('PENDIENTE', 'PROCESADO', 'RECHAZADO');
CREATE TYPE "entry_type" AS ENUM ('CONSULTA', 'DIAGNOSTICO', 'PRESCRIPCION', 'ESTUDIO', 'CORRECCION');
CREATE TYPE "summary_status" AS ENUM ('PENDIENTE_VALIDACION', 'VALIDADO', 'DESCARTADO');
CREATE TYPE "review_status" AS ENUM ('PENDIENTE_MODERACION', 'APROBADA', 'RECHAZADA');
CREATE TYPE "notification_type" AS ENUM ('TURNO_RESERVADO', 'RECORDATORIO_24H', 'RECORDATORIO_1H', 'NUEVO_MENSAJE', 'PAGO_CONFIRMADO', 'RESENA_MODERADA');
CREATE TYPE "notification_channel" AS ENUM ('IN_APP', 'PUSH', 'EMAIL');

-- CreateTable
CREATE TABLE "specialties" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "specialties_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "professional_specialties" (
    "professional_id" UUID NOT NULL,
    "specialty_id" UUID NOT NULL,

    CONSTRAINT "professional_specialties_pkey" PRIMARY KEY ("professional_id","specialty_id")
);

CREATE TABLE "professional_education" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "professional_id" UUID NOT NULL,
    "institution" TEXT NOT NULL,
    "degree" TEXT NOT NULL,
    "year" SMALLINT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "professional_education_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "reviews" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "patient_id" UUID NOT NULL,
    "professional_id" UUID NOT NULL,
    "appointment_id" UUID NOT NULL,
    "rating" SMALLINT NOT NULL,
    "comment" TEXT,
    "status" "review_status" NOT NULL DEFAULT 'PENDIENTE_MODERACION',
    "moderator_id" UUID,
    "moderation_reason" TEXT,
    "moderated_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reviews_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "review_responses" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "review_id" UUID NOT NULL,
    "professional_id" UUID NOT NULL,
    "content" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "review_responses_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "schedule_rules" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "professional_id" UUID NOT NULL,
    "weekday" SMALLINT NOT NULL,
    "start_time" TIME(6) NOT NULL,
    "end_time" TIME(6) NOT NULL,
    "slot_duration_minutes" SMALLINT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "schedule_rules_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "schedule_blocks" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "professional_id" UUID NOT NULL,
    "block_date" DATE NOT NULL,
    "reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "schedule_blocks_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "cancellation_policies" (
    "professional_id" UUID NOT NULL,
    "hours_full_refund" SMALLINT,
    "hours_partial_refund" SMALLINT,
    "partial_refund_percent" SMALLINT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cancellation_policies_pkey" PRIMARY KEY ("professional_id")
);

CREATE TABLE "appointments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "patient_id" UUID NOT NULL,
    "professional_id" UUID NOT NULL,
    "scheduled_at" TIMESTAMPTZ(6) NOT NULL,
    "duration_minutes" SMALLINT NOT NULL,
    "price" DECIMAL(10,2) NOT NULL,
    "status" "appointment_status" NOT NULL DEFAULT 'RESERVADO_SIN_PAGAR',
    "cancellation_reason" TEXT,
    "cancelled_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "appointments_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "consultations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "appointment_id" UUID NOT NULL,
    "started_at" TIMESTAMPTZ(6),
    "ended_at" TIMESTAMPTZ(6),
    "professional_notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "consultations_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "video_sessions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "consultation_id" UUID NOT NULL,
    "daily_room_name" TEXT,
    "daily_room_url" TEXT,
    "audio_recording_url" TEXT,
    "status" "video_session_status" NOT NULL DEFAULT 'CREADA',
    "started_at" TIMESTAMPTZ(6),
    "ended_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "video_sessions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "payments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "appointment_id" UUID NOT NULL,
    "mercadopago_preference_id" TEXT,
    "mercadopago_payment_id" TEXT,
    "amount" DECIMAL(10,2) NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'ARS',
    "method" TEXT,
    "status" "payment_status" NOT NULL DEFAULT 'PENDIENTE',
    "confirmed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "payment_webhook_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "payment_id" UUID,
    "mercadopago_payment_id" TEXT,
    "raw_payload" JSONB NOT NULL,
    "signature" TEXT,
    "processed" BOOLEAN NOT NULL DEFAULT false,
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ(6),

    CONSTRAINT "payment_webhook_events_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "refunds" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "payment_id" UUID NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "status" "refund_status" NOT NULL DEFAULT 'PENDIENTE',
    "reason" TEXT,
    "processed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refunds_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "clinical_record_entries" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "patient_id" UUID NOT NULL,
    "professional_id" UUID NOT NULL,
    "consultation_id" UUID,
    "corrects_entry_id" UUID,
    "entry_type" "entry_type" NOT NULL,
    "fhir_resource_type" TEXT NOT NULL,
    "content" JSONB NOT NULL,
    "sequence_number" BIGINT NOT NULL,
    "content_hash" CHAR(64) NOT NULL,
    "previous_hash" CHAR(64) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "clinical_record_entries_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "consultation_summaries" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "consultation_id" UUID NOT NULL,
    "transcription_text" TEXT,
    "summary_content" JSONB,
    "status" "summary_status" NOT NULL DEFAULT 'PENDIENTE_VALIDACION',
    "validated_by" UUID,
    "incorporated_entry_id" UUID,
    "generated_at" TIMESTAMPTZ(6),
    "validated_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "consultation_summaries_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "conversations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "patient_id" UUID NOT NULL,
    "professional_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversations_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "messages" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "conversation_id" UUID NOT NULL,
    "sender_id" UUID NOT NULL,
    "content" TEXT,
    "attachment_url" TEXT,
    "read_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "notifications" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "type" "notification_type" NOT NULL,
    "channel" "notification_channel" NOT NULL,
    "payload" JSONB,
    "sent_at" TIMESTAMPTZ(6),
    "read_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "push_tokens" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "token" TEXT NOT NULL,
    "platform" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "push_tokens_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "medipass_codes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "patient_id" UUID NOT NULL,
    "code" VARCHAR(8) NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "used_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "medipass_codes_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "medipass_sessions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "patient_id" UUID NOT NULL,
    "medipass_code_id" UUID NOT NULL,
    "consultant_profile_id" UUID,
    "consultant_name" TEXT,
    "consultant_license" VARCHAR(30),
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),
    "revoked_by" UUID,
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "medipass_sessions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "medipass_access_logs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "session_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "resource_accessed" TEXT,
    "accessed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "medipass_access_logs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "actor_id" UUID,
    "action" TEXT NOT NULL,
    "resource_type" TEXT NOT NULL,
    "resource_id" UUID,
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "integrity_checks" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "status" TEXT NOT NULL,
    "inconsistencies_found" INTEGER NOT NULL DEFAULT 0,
    "details" JSONB,
    "run_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "integrity_checks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "specialties_name_key" ON "specialties"("name");
CREATE UNIQUE INDEX "reviews_appointment_id_key" ON "reviews"("appointment_id");
CREATE UNIQUE INDEX "review_responses_review_id_key" ON "review_responses"("review_id");
CREATE INDEX "appointments_professional_id_scheduled_at_idx" ON "appointments"("professional_id", "scheduled_at");
CREATE INDEX "appointments_patient_id_scheduled_at_idx" ON "appointments"("patient_id", "scheduled_at");
CREATE UNIQUE INDEX "consultations_appointment_id_key" ON "consultations"("appointment_id");
CREATE UNIQUE INDEX "video_sessions_consultation_id_key" ON "video_sessions"("consultation_id");
CREATE UNIQUE INDEX "payments_appointment_id_key" ON "payments"("appointment_id");
CREATE INDEX "payment_webhook_events_mercadopago_payment_id_idx" ON "payment_webhook_events"("mercadopago_payment_id");
CREATE INDEX "clinical_record_entries_patient_id_sequence_number_idx" ON "clinical_record_entries"("patient_id", "sequence_number");
CREATE UNIQUE INDEX "clinical_record_entries_patient_id_sequence_number_key" ON "clinical_record_entries"("patient_id", "sequence_number");
CREATE UNIQUE INDEX "consultation_summaries_consultation_id_key" ON "consultation_summaries"("consultation_id");
CREATE UNIQUE INDEX "consultation_summaries_incorporated_entry_id_key" ON "consultation_summaries"("incorporated_entry_id");
CREATE UNIQUE INDEX "conversations_patient_id_professional_id_key" ON "conversations"("patient_id", "professional_id");
CREATE INDEX "messages_conversation_id_created_at_idx" ON "messages"("conversation_id", "created_at");
CREATE UNIQUE INDEX "push_tokens_token_key" ON "push_tokens"("token");
CREATE INDEX "medipass_sessions_patient_id_expires_at_idx" ON "medipass_sessions"("patient_id", "expires_at");

-- Índice GIN pg_trgm para búsqueda fuzzy del catálogo (esquema.md · "Índices recomendados").
-- Requiere la extensión pg_trgm (creada en el bootstrap local / disponible en Supabase).
CREATE INDEX "professionals_name_trgm_idx" ON "professionals" USING gin ("first_name" gin_trgm_ops, "last_name" gin_trgm_ops);

-- CheckConstraint (esquema.md, no expresables en Prisma)
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_rating_check" CHECK ("rating" BETWEEN 1 AND 5);
ALTER TABLE "schedule_rules" ADD CONSTRAINT "schedule_rules_weekday_check" CHECK ("weekday" BETWEEN 0 AND 6);
ALTER TABLE "schedule_rules" ADD CONSTRAINT "schedule_rules_time_order_check" CHECK ("end_time" > "start_time");
ALTER TABLE "schedule_rules" ADD CONSTRAINT "schedule_rules_slot_duration_check" CHECK ("slot_duration_minutes" IN (15, 30, 45, 60));
ALTER TABLE "cancellation_policies" ADD CONSTRAINT "cancellation_policies_partial_percent_check" CHECK ("partial_refund_percent" BETWEEN 0 AND 100);
ALTER TABLE "payments" ADD CONSTRAINT "payments_amount_check" CHECK ("amount" >= 0);
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_amount_check" CHECK ("amount" >= 0);
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_price_check" CHECK ("price" >= 0);

-- AddForeignKey
ALTER TABLE "professional_specialties" ADD CONSTRAINT "professional_specialties_professional_id_fkey" FOREIGN KEY ("professional_id") REFERENCES "professionals"("profile_id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "professional_specialties" ADD CONSTRAINT "professional_specialties_specialty_id_fkey" FOREIGN KEY ("specialty_id") REFERENCES "specialties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "professional_education" ADD CONSTRAINT "professional_education_professional_id_fkey" FOREIGN KEY ("professional_id") REFERENCES "professionals"("profile_id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("profile_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_professional_id_fkey" FOREIGN KEY ("professional_id") REFERENCES "professionals"("profile_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_appointment_id_fkey" FOREIGN KEY ("appointment_id") REFERENCES "appointments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_moderator_id_fkey" FOREIGN KEY ("moderator_id") REFERENCES "profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "review_responses" ADD CONSTRAINT "review_responses_review_id_fkey" FOREIGN KEY ("review_id") REFERENCES "reviews"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "review_responses" ADD CONSTRAINT "review_responses_professional_id_fkey" FOREIGN KEY ("professional_id") REFERENCES "professionals"("profile_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "schedule_rules" ADD CONSTRAINT "schedule_rules_professional_id_fkey" FOREIGN KEY ("professional_id") REFERENCES "professionals"("profile_id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "schedule_blocks" ADD CONSTRAINT "schedule_blocks_professional_id_fkey" FOREIGN KEY ("professional_id") REFERENCES "professionals"("profile_id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "cancellation_policies" ADD CONSTRAINT "cancellation_policies_professional_id_fkey" FOREIGN KEY ("professional_id") REFERENCES "professionals"("profile_id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("profile_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_professional_id_fkey" FOREIGN KEY ("professional_id") REFERENCES "professionals"("profile_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "consultations" ADD CONSTRAINT "consultations_appointment_id_fkey" FOREIGN KEY ("appointment_id") REFERENCES "appointments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "video_sessions" ADD CONSTRAINT "video_sessions_consultation_id_fkey" FOREIGN KEY ("consultation_id") REFERENCES "consultations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "payments" ADD CONSTRAINT "payments_appointment_id_fkey" FOREIGN KEY ("appointment_id") REFERENCES "appointments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "payment_webhook_events" ADD CONSTRAINT "payment_webhook_events_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "clinical_record_entries" ADD CONSTRAINT "clinical_record_entries_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("profile_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "clinical_record_entries" ADD CONSTRAINT "clinical_record_entries_professional_id_fkey" FOREIGN KEY ("professional_id") REFERENCES "professionals"("profile_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "clinical_record_entries" ADD CONSTRAINT "clinical_record_entries_consultation_id_fkey" FOREIGN KEY ("consultation_id") REFERENCES "consultations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "clinical_record_entries" ADD CONSTRAINT "clinical_record_entries_corrects_entry_id_fkey" FOREIGN KEY ("corrects_entry_id") REFERENCES "clinical_record_entries"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "consultation_summaries" ADD CONSTRAINT "consultation_summaries_consultation_id_fkey" FOREIGN KEY ("consultation_id") REFERENCES "consultations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "consultation_summaries" ADD CONSTRAINT "consultation_summaries_validated_by_fkey" FOREIGN KEY ("validated_by") REFERENCES "professionals"("profile_id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "consultation_summaries" ADD CONSTRAINT "consultation_summaries_incorporated_entry_id_fkey" FOREIGN KEY ("incorporated_entry_id") REFERENCES "clinical_record_entries"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("profile_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_professional_id_fkey" FOREIGN KEY ("professional_id") REFERENCES "professionals"("profile_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "messages" ADD CONSTRAINT "messages_sender_id_fkey" FOREIGN KEY ("sender_id") REFERENCES "profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "push_tokens" ADD CONSTRAINT "push_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "medipass_codes" ADD CONSTRAINT "medipass_codes_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("profile_id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "medipass_sessions" ADD CONSTRAINT "medipass_sessions_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("profile_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "medipass_sessions" ADD CONSTRAINT "medipass_sessions_medipass_code_id_fkey" FOREIGN KEY ("medipass_code_id") REFERENCES "medipass_codes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "medipass_sessions" ADD CONSTRAINT "medipass_sessions_consultant_profile_id_fkey" FOREIGN KEY ("consultant_profile_id") REFERENCES "profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "medipass_sessions" ADD CONSTRAINT "medipass_sessions_revoked_by_fkey" FOREIGN KEY ("revoked_by") REFERENCES "profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "medipass_access_logs" ADD CONSTRAINT "medipass_access_logs_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "medipass_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "medipass_access_logs" ADD CONSTRAINT "medipass_access_logs_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("profile_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;
