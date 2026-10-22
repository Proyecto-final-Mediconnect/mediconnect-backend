import {
  ConflictException,
  GoneException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { OpenEmergencySessionDto } from './dto/open-emergency-session.dto';
import {
  CODE_ALPHABET,
  CODE_LENGTH,
  CODE_MAX_ATTEMPTS,
} from './medipass.config';
import { MediPassService } from './medipass.service';

const PATIENT = '11111111-1111-4111-8111-111111111111';
const CODE_ID = '33333333-3333-4333-8333-333333333333';
const SESSION = '44444444-4444-4444-8444-444444444444';

const PATIENT_ROW = {
  first_name: 'Marina',
  last_name: 'Ocampo',
  birth_date: new Date('1991-03-02T00:00:00.000Z'),
};

type PrismaMock = {
  patient: { findUnique: jest.Mock };
  mediPassCode: {
    findFirst: jest.Mock;
    updateMany: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
  };
  mediPassSession: {
    create: jest.Mock;
    findUnique: jest.Mock;
    findMany: jest.Mock;
    updateMany: jest.Mock;
  };
  mediPassAccessLog: { create: jest.Mock };
  auditLog: { create: jest.Mock };
  $transaction: jest.Mock;
};

describe('MediPassService', () => {
  let prisma: PrismaMock;
  let service: MediPassService;

  beforeEach(() => {
    prisma = {
      patient: { findUnique: jest.fn().mockResolvedValue(PATIENT_ROW) },
      mediPassCode: {
        findFirst: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        create: jest.fn(),
        update: jest.fn(),
      },
      mediPassSession: {
        create: jest.fn(),
        findUnique: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      mediPassAccessLog: { create: jest.fn() },
      auditLog: { create: jest.fn() },
      $transaction: jest.fn(),
    };
    // Transacción interactiva: el callback corre contra el mismo mock.
    prisma.$transaction.mockImplementation((fn: (tx: unknown) => unknown) =>
      fn(prisma),
    );
    service = new MediPassService(prisma as unknown as PrismaService);
  });

  describe('getMyCode', () => {
    it('devuelve el código vigente sin generar otro', async () => {
      const expira = new Date(Date.now() + 120_000);
      prisma.mediPassCode.findFirst.mockResolvedValue({
        code: 'BCD23FGH',
        expires_at: expira,
      });

      const res = await service.getMyCode(PATIENT);

      expect(res).toEqual({
        codigo: 'BCD23FGH',
        expiraEl: expira.toISOString(),
      });
      expect(prisma.mediPassCode.create).not.toHaveBeenCalled();
    });

    it('si el vigente venció, genera el siguiente en la misma llamada', async () => {
      // El paciente abre la pantalla después de un rato: no puede recibir un
      // código muerto ni tener que recargar para que aparezca el nuevo.
      prisma.mediPassCode.findFirst.mockResolvedValue(null);
      prisma.mediPassCode.create.mockImplementation(
        ({ data }: { data: { code: string; expires_at: Date } }) =>
          Promise.resolve({ code: data.code, expires_at: data.expires_at }),
      );

      const res = await service.getMyCode(PATIENT);

      expect(prisma.mediPassCode.create).toHaveBeenCalledTimes(1);
      expect(res.codigo).toHaveLength(CODE_LENGTH);
      expect(new Date(res.expiraEl).getTime()).toBeGreaterThan(Date.now());
    });

    it('al generar uno nuevo vence los anteriores, para que quede uno solo', async () => {
      prisma.mediPassCode.findFirst.mockResolvedValue(null);
      prisma.mediPassCode.create.mockImplementation(
        ({ data }: { data: { code: string; expires_at: Date } }) =>
          Promise.resolve({ code: data.code, expires_at: data.expires_at }),
      );

      await service.getMyCode(PATIENT);

      expect(prisma.mediPassCode.updateMany).toHaveBeenCalledTimes(1);
      const call = prisma.mediPassCode.updateMany.mock.calls[0][0] as {
        where: { patient_id: string };
      };
      expect(call.where.patient_id).toBe(PATIENT);
    });

    it('el código usa solo el alfabeto sin vocales ni ambiguos', async () => {
      prisma.mediPassCode.findFirst.mockResolvedValue(null);
      prisma.mediPassCode.create.mockImplementation(
        ({ data }: { data: { code: string; expires_at: Date } }) =>
          Promise.resolve({ code: data.code, expires_at: data.expires_at }),
      );

      // Varias veces: un alfabeto mal armado puede pasar desapercibido una vez.
      for (let i = 0; i < 25; i += 1) {
        const { codigo } = await service.getMyCode(PATIENT);
        expect(codigo).toMatch(
          new RegExp(`^[${CODE_ALPHABET}]{${CODE_LENGTH}}$`),
        );
      }
    });

    it('sin perfil cargado avisa qué hacer en vez de fallar', async () => {
      prisma.patient.findUnique.mockResolvedValue(null);

      await expect(service.getMyCode(PATIENT)).rejects.toThrow(
        ConflictException,
      );
    });
  });

  describe('getMyVitalBlock', () => {
    it('devuelve el bloque vital del propio paciente', async () => {
      const vital = await service.getMyVitalBlock(PATIENT);

      expect(vital.nombre).toBe('Marina Ocampo');
      expect(vital.grupoSanguineo).toBeNull();
    });

    it('sin perfil cargado avisa qué hacer', async () => {
      prisma.patient.findUnique.mockResolvedValue(null);

      await expect(service.getMyVitalBlock(PATIENT)).rejects.toThrow(
        ConflictException,
      );
    });
  });

  describe('openSession', () => {
    const dto: OpenEmergencySessionDto = {
      codigo: 'BCD23FGH',
      nombre: 'Dra. Paula Ferrer',
      matricula: 'MP 12345',
    };

    function codeVigente(used_at: Date | null = null) {
      return {
        id: CODE_ID,
        patient_id: PATIENT,
        used_at,
        patient: PATIENT_ROW,
      };
    }

    it('abre la sesión, la registra en la bitácora y devuelve la ficha', async () => {
      prisma.mediPassCode.findFirst.mockResolvedValue(codeVigente());

      const res = await service.openSession(dto);

      expect(res.vital.nombre).toBe('Marina Ocampo');
      expect(new Date(res.expiraEl).getTime()).toBeGreaterThan(Date.now());
      expect(prisma.mediPassSession.create).toHaveBeenCalledTimes(1);
      expect(prisma.mediPassAccessLog.create).toHaveBeenCalledTimes(1);

      const sesion = prisma.mediPassSession.create.mock.calls[0][0] as {
        data: { consultant_name: string; consultant_license: string | null };
      };
      expect(sesion.data.consultant_name).toBe('Dra. Paula Ferrer');
      expect(sesion.data.consultant_license).toBe('MP 12345');
    });

    it('la sesión y su entrada en la bitácora van en la misma transacción', async () => {
      // Un acceso que no quedó registrado es exactamente el que el paciente no
      // puede auditar: no pueden entrar por separado.
      prisma.mediPassCode.findFirst.mockResolvedValue(codeVigente());

      await service.openSession(dto);

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    });

    it('sin matrícula guarda null y no un string vacío', async () => {
      prisma.mediPassCode.findFirst.mockResolvedValue(codeVigente());

      await service.openSession({ codigo: dto.codigo, nombre: dto.nombre });

      const sesion = prisma.mediPassSession.create.mock.calls[0][0] as {
        data: { consultant_license: string | null };
      };
      expect(sesion.data.consultant_license).toBeNull();
    });

    it('marca used_at en el primer canje', async () => {
      prisma.mediPassCode.findFirst.mockResolvedValue(codeVigente(null));

      await service.openSession(dto);

      expect(prisma.mediPassCode.update).toHaveBeenCalledTimes(1);
    });

    it('el código no es de un solo uso: un segundo canje abre otra sesión', async () => {
      // Un médico que recarga la página no puede quedar afuera, y en una guardia
      // puede haber más de uno mirando. Cada canje tiene su sesión para que el
      // paciente pueda revocar una sin revocar las otras.
      prisma.mediPassCode.findFirst.mockResolvedValue(
        codeVigente(new Date('2026-10-20T15:00:00.000Z')),
      );

      const res = await service.openSession(dto);

      expect(res.sesionId).toBeDefined();
      expect(prisma.mediPassSession.create).toHaveBeenCalledTimes(1);
      // `used_at` ya estaba: queda como el primer uso y no se sobrescribe.
      expect(prisma.mediPassCode.update).not.toHaveBeenCalled();
    });

    it('un código que no existe y uno vencido dan el mismo rechazo', async () => {
      // La consulta ya filtra por `expires_at > now`, así que los dos casos
      // llegan acá como `null`: no hay forma de distinguirlos desde afuera.
      prisma.mediPassCode.findFirst.mockResolvedValue(null);

      await expect(service.openSession(dto)).rejects.toThrow(NotFoundException);
      await expect(service.openSession(dto)).rejects.toThrow(
        'Código inválido o vencido.',
      );
      expect(prisma.mediPassSession.create).not.toHaveBeenCalled();
    });

    it('solo busca códigos que no vencieron', async () => {
      prisma.mediPassCode.findFirst.mockResolvedValue(null);

      await expect(service.openSession(dto)).rejects.toThrow(NotFoundException);

      const where = prisma.mediPassCode.findFirst.mock.calls[0][0] as {
        where: { code: string; expires_at: { gt: Date } };
      };
      expect(where.where.code).toBe('BCD23FGH');
      expect(where.where.expires_at.gt).toBeInstanceOf(Date);
    });
  });

  describe('getSessionStatus', () => {
    it('devuelve la ficha mientras el acceso sigue vivo', async () => {
      const expira = new Date(Date.now() + 600_000);
      prisma.mediPassSession.findUnique.mockResolvedValue({
        expires_at: expira,
        revoked_at: null,
        patient: PATIENT_ROW,
      });

      const res = await service.getSessionStatus(SESSION);

      expect(res.expiraEl).toBe(expira.toISOString());
      expect(res.vital.nombre).toBe('Marina Ocampo');
    });

    it('410 cuando venció, para distinguirlo de un corte de red', async () => {
      // Es lo único que le permite a la pantalla no cerrarse sola cuando el
      // celular se queda sin señal un segundo.
      prisma.mediPassSession.findUnique.mockResolvedValue({
        expires_at: new Date(Date.now() - 1_000),
        revoked_at: null,
        patient: PATIENT_ROW,
      });

      await expect(service.getSessionStatus(SESSION)).rejects.toThrow(
        GoneException,
      );
    });

    it('410 cuando el paciente la revocó, aunque no haya vencido', async () => {
      prisma.mediPassSession.findUnique.mockResolvedValue({
        expires_at: new Date(Date.now() + 600_000),
        revoked_at: new Date(),
        patient: PATIENT_ROW,
      });

      await expect(service.getSessionStatus(SESSION)).rejects.toThrow(
        GoneException,
      );
    });

    it('no vence por el reloj de la fila sino por el del servidor', async () => {
      // El job que materializa el vencimiento puede no haber corrido: ninguna
      // lectura devuelve datos de una sesión vencida igual (mismo criterio que
      // ENG-101).
      prisma.mediPassSession.findUnique.mockResolvedValue({
        expires_at: new Date(Date.now() - 60_000),
        revoked_at: null,
        patient: PATIENT_ROW,
      });

      await expect(service.getSessionStatus(SESSION)).rejects.toThrow(
        GoneException,
      );
    });

    it('una sesión que no existe es 404 con el mensaje genérico', async () => {
      prisma.mediPassSession.findUnique.mockResolvedValue(null);

      await expect(service.getSessionStatus(SESSION)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('un id con forma inválida no llega a la base', async () => {
      await expect(service.getSessionStatus('no-es-uuid')).rejects.toThrow(
        NotFoundException,
      );
      expect(prisma.mediPassSession.findUnique).not.toHaveBeenCalled();
    });
  });

  describe('unicidad del código (ENG-170)', () => {
    /** El `P2002` que devuelve Prisma cuando choca la unique de `code`. */
    function colisionDeCodigo() {
      return Object.assign(new Error('Unique constraint failed'), {
        code: 'P2002',
        meta: { target: ['code'] },
      });
    }

    beforeEach(() => {
      // Sin código vigente, así que `getMyCode` entra al camino de creación.
      prisma.mediPassCode.findFirst.mockResolvedValue(null);
      prisma.mediPassCode.create.mockImplementation(
        ({ data }: { data: { code: string; expires_at: Date } }) =>
          Promise.resolve({ code: data.code, expires_at: data.expires_at }),
      );
    });

    it('reintenta con otro código cuando el sorteado ya existía', async () => {
      // Antes de ENG-170 no había unique y el duplicado entraba: dos pacientes
      // con el mismo código vigente hacían que el canje devolviera la ficha del
      // paciente equivocado.
      prisma.mediPassCode.create
        .mockRejectedValueOnce(colisionDeCodigo())
        .mockImplementationOnce(
          ({ data }: { data: { code: string; expires_at: Date } }) =>
            Promise.resolve({ code: data.code, expires_at: data.expires_at }),
        );

      const res = await service.getMyCode(PATIENT);

      expect(prisma.mediPassCode.create).toHaveBeenCalledTimes(2);
      expect(res.codigo).toHaveLength(CODE_LENGTH);
    });

    it('el reintento sortea un código distinto del que chocó', async () => {
      // Reintentar con el mismo valor sería un bucle garantizado.
      prisma.mediPassCode.create.mockRejectedValueOnce(colisionDeCodigo());

      await service.getMyCode(PATIENT);

      const primero = prisma.mediPassCode.create.mock.calls[0][0] as {
        data: { code: string };
      };
      const segundo = prisma.mediPassCode.create.mock.calls[1][0] as {
        data: { code: string };
      };
      expect(segundo.data.code).not.toBe(primero.data.code);
    });

    it('no reintenta para siempre', async () => {
      prisma.mediPassCode.create.mockRejectedValue(colisionDeCodigo());

      await expect(service.getMyCode(PATIENT)).rejects.toThrow();
      expect(prisma.mediPassCode.create).toHaveBeenCalledTimes(
        CODE_MAX_ATTEMPTS,
      );
    });

    it('una unique de otra columna NO se reintenta', async () => {
      // Reintentar con un código nuevo no arreglaría una colisión en otra
      // columna: solo la escondería detrás de tres intentos.
      prisma.mediPassCode.create.mockRejectedValue(
        Object.assign(new Error('Unique constraint failed'), {
          code: 'P2002',
          meta: { target: ['patient_id'] },
        }),
      );

      await expect(service.getMyCode(PATIENT)).rejects.toThrow();
      expect(prisma.mediPassCode.create).toHaveBeenCalledTimes(1);
    });

    it('un error que no es de unicidad sale en el primer intento', async () => {
      prisma.mediPassCode.create.mockRejectedValue(new Error('base caída'));

      await expect(service.getMyCode(PATIENT)).rejects.toThrow('base caída');
      expect(prisma.mediPassCode.create).toHaveBeenCalledTimes(1);
    });
  });

  describe('listMyAccesses (ENG-74)', () => {
    const SESSION_ROW = {
      id: SESSION,
      consultant_name: 'Dr. Pablo Rivas',
      consultant_license: 'MP 12345',
      started_at: new Date('2026-10-21T14:50:00.000Z'),
      expires_at: new Date(Date.now() + 20 * 60_000),
    };

    it('devuelve los accesos vigentes del paciente', async () => {
      prisma.mediPassSession.findMany.mockResolvedValue([SESSION_ROW]);

      const accesos = await service.listMyAccesses(PATIENT);

      expect(accesos).toHaveLength(1);
      expect(accesos[0]).toMatchObject({
        id: SESSION,
        consultante: 'Dr. Pablo Rivas',
        matricula: 'MP 12345',
      });
    });

    it('solo pide sesiones del paciente, sin revocar y sin vencer', async () => {
      // Es la autorización de esta ruta: el filtrado por `patient_id` lo hace
      // este código y no RLS, porque el backend entra como dueño de la tabla.
      await service.listMyAccesses(PATIENT);

      const { where, orderBy } = prisma.mediPassSession.findMany.mock
        .calls[0][0] as {
        where: Record<string, unknown>;
        orderBy: Record<string, unknown>;
      };
      expect(where.patient_id).toBe(PATIENT);
      expect(where.revoked_at).toBeNull();
      expect(where.expires_at).toEqual({ gt: expect.any(Date) });
      expect(orderBy).toEqual({ expires_at: 'asc' });
    });

    it('sin accesos abiertos devuelve una lista vacía, no un error', async () => {
      await expect(service.listMyAccesses(PATIENT)).resolves.toEqual([]);
    });

    it('un usuario sin fila de paciente recibe 409 y no consulta sesiones', async () => {
      prisma.patient.findUnique.mockResolvedValue(null);

      await expect(service.listMyAccesses(PATIENT)).rejects.toThrow(
        ConflictException,
      );
      expect(prisma.mediPassSession.findMany).not.toHaveBeenCalled();
    });
  });

  describe('revokeAccess (ENG-75)', () => {
    function sesionAbierta(overrides: Record<string, unknown> = {}) {
      return {
        patient_id: PATIENT,
        revoked_at: null,
        expires_at: new Date(Date.now() + 10 * 60_000),
        consultant_name: 'Dr. Pablo Rivas',
        consultant_license: 'MP 12345',
        ...overrides,
      };
    }

    it('marca la sesión como revocada y por quién', async () => {
      prisma.mediPassSession.findUnique.mockResolvedValue(sesionAbierta());

      await service.revokeAccess(PATIENT, SESSION);

      const { where, data } = prisma.mediPassSession.updateMany.mock
        .calls[0][0] as {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      };
      expect(where).toMatchObject({
        id: SESSION,
        patient_id: PATIENT,
        revoked_at: null,
      });
      expect(data.revoked_at).toBeInstanceOf(Date);
      expect(data.revoked_by).toBe(PATIENT);
    });

    it('deja la revocación en audit_logs', async () => {
      prisma.mediPassSession.findUnique.mockResolvedValue(sesionAbierta());

      await service.revokeAccess(PATIENT, SESSION);

      expect(prisma.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          actor_id: PATIENT,
          action: 'MEDIPASS_ACCESS_REVOKED',
          resource_type: 'medipass_sessions',
          resource_id: SESSION,
          metadata: expect.objectContaining({
            consultante: 'Dr. Pablo Rivas',
            matricula: 'MP 12345',
          }),
        }),
      });
    });

    it('la sesión de otro paciente es 404 y no se toca', async () => {
      // Mismo 404 que una inexistente: un 403 confirmaría que ese id existe.
      prisma.mediPassSession.findUnique.mockResolvedValue(
        sesionAbierta({ patient_id: '99999999-9999-4999-8999-999999999999' }),
      );

      await expect(service.revokeAccess(PATIENT, SESSION)).rejects.toThrow(
        NotFoundException,
      );
      expect(prisma.mediPassSession.updateMany).not.toHaveBeenCalled();
    });

    it('una sesión que no existe es 404', async () => {
      prisma.mediPassSession.findUnique.mockResolvedValue(null);

      await expect(service.revokeAccess(PATIENT, SESSION)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('revocar dos veces no da error ni escribe un segundo log', async () => {
      // Doble click del paciente: el resultado es el que pedía, no una falla.
      prisma.mediPassSession.findUnique.mockResolvedValue(
        sesionAbierta({ revoked_at: new Date() }),
      );

      await expect(
        service.revokeAccess(PATIENT, SESSION),
      ).resolves.toBeUndefined();
      expect(prisma.mediPassSession.updateMany).not.toHaveBeenCalled();
      expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });

    it('una sesión ya vencida no se marca como revocada', async () => {
      // El paciente no cortó este acceso: se cerró solo. Marcarlo falsearía el
      // historial que ENG-76 va a mostrar.
      prisma.mediPassSession.findUnique.mockResolvedValue(
        sesionAbierta({ expires_at: new Date(Date.now() - 60_000) }),
      );

      await expect(
        service.revokeAccess(PATIENT, SESSION),
      ).resolves.toBeUndefined();
      expect(prisma.mediPassSession.updateMany).not.toHaveBeenCalled();
      expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });

    it('si pierde la carrera no escribe un log de algo que no pasó', async () => {
      // El job de ENG-104 venció la fila entre la lectura y el update.
      prisma.mediPassSession.findUnique.mockResolvedValue(sesionAbierta());
      prisma.mediPassSession.updateMany.mockResolvedValue({ count: 0 });

      await service.revokeAccess(PATIENT, SESSION);

      expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });

    it('si falla la auditoría, la revocación no queda silenciosamente a medias', async () => {
      // Van en la misma transacción: el único resultado inaceptable es que el
      // paciente crea que cortó un acceso que sigue abierto.
      prisma.mediPassSession.findUnique.mockResolvedValue(sesionAbierta());
      prisma.auditLog.create.mockRejectedValue(new Error('audit caído'));

      await expect(service.revokeAccess(PATIENT, SESSION)).rejects.toThrow(
        InternalServerErrorException,
      );
    });
  });
});
