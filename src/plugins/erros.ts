import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { ZodError } from 'zod';
import { ErroApp } from '../lib/erros.js';

type ErroNormalizado = {
  erro: string;
  codigo: string;
  mensagem: string;
  detalhes?: unknown;
};

export const pluginErros = fp(async (app: FastifyInstance) => {
  app.setNotFoundHandler((req: FastifyRequest, reply: FastifyReply) => {
    reply.code(404).send({
      erro: 'NAO_ENCONTRADO',
      codigo: 'ROTA_INEXISTENTE',
      mensagem: `Rota inexistente: ${req.method} ${req.url}`,
    } satisfies ErroNormalizado);
  });

  app.setErrorHandler((err: FastifyError | Error, req: FastifyRequest, reply: FastifyReply) => {
    // Erros de dominio ja trazem status e codigo proprios.
    if (err instanceof ErroApp) {
      const corpo: ErroNormalizado = {
        erro: err.status === 500 ? 'ERRO_INTERNO' : 'ERRO_DOMINIO',
        codigo: err.codigo,
        mensagem: err.message,
      };
      if (err.detalhes !== undefined) corpo.detalhes = err.detalhes;
      return reply.code(err.status).send(corpo);
    }

    if (err instanceof ZodError) {
      return reply.code(400).send({
        erro: 'ERRO_DOMINIO',
        codigo: 'VALIDACAO',
        mensagem: 'Dados invalidos',
        detalhes: err.issues.map((i) => ({
          campo: i.path.join('.') || '(raiz)',
          mensagem: i.message,
        })),
      } satisfies ErroNormalizado);
    }

    // Limites do multipart (excedeu UPLOAD_MAX_BYTES).
    const anyErr = err as { statusCode?: number; code?: string; message?: string };
    if (anyErr.code === 'FST_REQ_FILE_TOO_LARGE') {
      return reply.code(413).send({
        erro: 'ERRO_DOMINIO',
        codigo: 'FICHEIRO_GRANDE',
        mensagem: 'O ficheiro excede o tamanho maximo permitido',
      } satisfies ErroNormalizado);
    }

    // Violacao de unicidade do PostgreSQL -> conflito, nao 500.
    if (anyErr.code === '23505') {
      return reply.code(409).send({
        erro: 'ERRO_DOMINIO',
        codigo: 'DUPLICADO',
        mensagem: 'Ja existe um registo com estes dados',
        detalhes: { detalhe: anyErr.message },
      } satisfies ErroNormalizado);
    }
    if (anyErr.code === '23503') {
      return reply.code(422).send({
        erro: 'ERRO_DOMINIO',
        codigo: 'REFERENCIA_INVALIDA',
        mensagem: 'Referencia a um registo inexistente',
        detalhes: { detalhe: anyErr.message },
      } satisfies ErroNormalizado);
    }
    if (anyErr.code === '23514') {
      return reply.code(422).send({
        erro: 'ERRO_DOMINIO',
        codigo: 'REGRA_BASE_DADOS',
        mensagem: 'Violou uma regra de integridade do sistema',
        detalhes: { detalhe: anyErr.message },
      } satisfies ErroNormalizado);
    }

    const status = anyErr.statusCode ?? 500;
    if (status >= 500) {
      req.log.error({ err }, 'erro nao tratado');
      return reply.code(500).send({
        erro: 'ERRO_INTERNO',
        codigo: 'INESPERADO',
        mensagem: 'Ocorreu um erro inesperado',
      } satisfies ErroNormalizado);
    }

    return reply.code(status).send({
      erro: 'ERRO_DOMINIO',
      codigo: anyErr.code ?? 'ERRO',
      mensagem: anyErr.message ?? 'Erro',
    } satisfies ErroNormalizado);
  });
});