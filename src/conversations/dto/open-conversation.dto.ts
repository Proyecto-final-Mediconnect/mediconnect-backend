import { IsUUID } from 'class-validator';

/** `POST /conversations` (ENG-70): con quién se abre la conversación. */
export class OpenConversationDto {
  /** `profiles.id` de la otra persona: el profesional si escribe un paciente, y al revés. */
  @IsUUID('4', { message: 'contraparteId debe ser un UUID' })
  contraparteId!: string;
}
