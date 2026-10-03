import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { ErroValidacao } from '../lib/erros.js';
import { guardarBuffer } from '../lib/uploads.js';

/**
 * Upload de ficheiros: fotos do diario e comprovativos de
 * pagamento.
 *
 * O conteudo vai em base64 dentro de um JSON — e' o caminho
 * que `guardarBuffer` foi feito para servir (o cliente, mesmo
 * offline, ja' tem o ficheiro em memoria como buffer). A url
 * devolvida e' servida estaticamente em `/uploads/` e guarda-se
 * em `diario_fotos.url` ou `pagamentos.comprovativo_url`.
 */
const schemaUpload = z.object({
  tipo: z.enum([
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/heic',
    'application/pdf',
  ]),
  /** Ficheiro inteiro, codificado em base64. */
  dados: z.string().base64(),
  /** 'diario' (fotos do diario) ou 'comprovativo' (pagamentos). */
  prefixo: z.enum(['diario', 'comprovativo']).default('diario'),
});

export async function rotasFicheiros(app: FastifyInstance) {
  app.addHook('preHandler', app.autenticar);

  app.post(
    '/',
    {
      preHandler: [
        // Quem escreve o diario ou regista pagamentos.
        app.exigir('diario:escrever', 'pagamentos:registar'),
      ],
    },
    async (req: FastifyRequest) => {
      const entrada = schemaUpload.parse(req.body);

      // O base64 incha cerca de 4/3: cortar antes de alocar
      // o buffer, nao depois.
      const limiteBase64 = Math.floor((config.uploads.maxBytes * 4) / 3);
      if (entrada.dados.length > limiteBase64) {
        throw new ErroValidacao(
          `O ficheiro excede ${Math.round(config.uploads.maxBytes / 1024 / 1024)} MB`,
        );
      }

      const guardado = await guardarBuffer(
        Buffer.from(entrada.dados, 'base64'),
        entrada.tipo,
        req.tenantId!,
        entrada.prefixo,
      );

      return {
        url: guardado.url,
        tamanho: guardado.tamanho,
        contentType: guardado.contentType,
      };
    },
  );
}
