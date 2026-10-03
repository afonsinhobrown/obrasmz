import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, stat, unlink, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { MultipartFile } from '@fastify/multipart';
import { config } from '../config.js';
import { ErroValidacao } from '../lib/erros.js';

/**
 * Tipos aceites para fotos de diario e comprovativos de pagamento. A lista e
 * fechada de proposito: um `.html` ou `.svg` servido do mesmo dominio que a
 * API pode ser usado para XSS com o cookies do utilizador.
 */
const TIPOS_ACEITES: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/heic': '.heic',
  'application/pdf': '.pdf',
};

const EXTENSOES_PERMITIDAS = new Set(Object.values(TIPOS_ACEITES));

export type FicheiroGuardado = {
  url: string;
  caminho: string;
  nomeOriginal: string;
  tamanho: number;
  contentType: string;
  hash: string;
};

/**
 * Guarda um ficheiro enviado em `uploads/<tenant>/<ano>/<mes>/<uuid>.<ext>`.
 *
 * O nome e sempre gerado no servidor. Nunca usamos o nome que veio do cliente:
 * `../../etc/passwd` e `diario.jpg.exe` ficam impedidos por construcao, e nao
 * por uma validacao de extensao.
 */
export async function guardarFicheiro(
  ficheiro: MultipartFile,
  tenantId: string,
  prefixo: 'diario' | 'comprovativo' = 'diario',
): Promise<FicheiroGuardado> {
  const tipo = ficheiro.mimetype.toLowerCase();
  const extensao = TIPOS_ACEITES[tipo];

  if (!extensao) {
    throw new ErroValidacao(
      `Tipo de ficheiro nao aceite: ${tipo}. Aceites: ${[...EXTENSOES_PERMITIDAS].join(', ')}`,
    );
  }

  const original = extname(ficheiro.filename ?? '').toLowerCase();
  if (original && !EXTENSOES_PERMITIDAS.has(original) && original !== extensao) {
    throw new ErroValidacao(
      `A extensao "${original}" nao corresponde ao conteudo (${tipo}).`,
    );
  }

  const agora = new Date();
  const dir = join(
    config.uploads.dir,
    tenantId,
    prefixo,
    String(agora.getFullYear()),
    String(agora.getMonth() + 1).padStart(2, '0'),
  );
  await mkdir(dir, { recursive: true });

  const nome = `${randomUUID()}${extensao}`;
  const caminho = join(dir, nome);

  const limite = config.uploads.maxBytes;
  let tamanho = 0;
  const hash = createHash('sha256');

  // Contamos os bytes enquanto escrevemos, para cortar o ficheiro a meio em
  // vez de aceitar o que o cliente mandar.
  ficheiro.file.on('data', (pedaco: Buffer) => {
    tamanho += pedaco.length;
    hash.update(pedaco);
    if (tamanho > limite) ficheiro.file.destroy(new Error('FICHEIRO_GRANDE'));
  });

  try {
    await pipeline(ficheiro.file, createWriteStream(caminho));
  } catch (err) {
    await unlink(caminho).catch(() => undefined);
    if ((err as Error).message === 'FICHEIRO_GRANDE') {
      throw new ErroValidacao(
        `O ficheiro excede ${Math.round(limite / 1024 / 1024)} MB`,
      );
    }
    throw err;
  }

  if (tamanho === 0) {
    await unlink(caminho).catch(() => undefined);
    throw new ErroValidacao('O ficheiro enviado esta vazio');
  }

  return {
    url: `${config.uploads.baseUrl}/${tenantId}/${prefixo}/${agora.getFullYear()}/${String(
      agora.getMonth() + 1,
    ).padStart(2, '0')}/${nome}`,
    caminho,
    nomeOriginal: ficheiro.filename ?? nome,
    tamanho,
    contentType: tipo,
    hash: hash.digest('hex'),
  };
}

/** Apaga um ficheiro previously guardado. Silencioso se ja nao existir. */
export async function apagarFicheiro(caminhoOuUrl: string): Promise<void> {
  const caminho = caminhoOuUrl.startsWith(config.uploads.baseUrl)
    ? join(config.uploads.dir, caminhoOuUrl.slice(config.uploads.baseUrl.length + 1))
    : caminhoOuUrl;

  // Impede que um `caminhoOuUrl` malicioso escape da pasta de uploads.
  const raiz = config.uploads.dir;
  if (!caminho.startsWith(raiz)) {
    throw new ErroValidacao('Caminho de ficheiro invalido');
  }

  await unlink(caminho).catch(() => undefined);
}

/** Le os campos de texto que acompanham um ficheiro no multipart. */
export async function lerCampo<T>(
  partes: AsyncIterable<MultipartFile>,
  campo: string,
  transformar?: (v: string) => T,
): Promise<T | undefined> {
  for await (const parte of partes) {
    if (parte.fieldname !== campo) continue;
    const valor = (await parte.toBuffer()).toString('utf8').trim();
    if (!valor) return undefined;
    return transformar ? transformar(valor) : (valor as T);
  }
  return undefined;
}

export async function existeFicheiro(caminho: string): Promise<boolean> {
  try {
    await stat(caminho);
    return true;
  } catch {
    return false;
  }
}

/**
 * Escrita direta em memoria — usada quando o ficheiro ja vem como buffer
 * (upload em base64 do cliente offline).
 */
export async function guardarBuffer(
  dados: Buffer,
  contentType: string,
  tenantId: string,
  prefixo: 'diario' | 'comprovativo' = 'diario',
): Promise<FicheiroGuardado> {
  const extensao = TIPOS_ACEITES[contentType.toLowerCase()];
  if (!extensao) throw new ErroValidacao(`Tipo de ficheiro nao aceite: ${contentType}`);
  if (dados.length > config.uploads.maxBytes) {
    throw new ErroValidacao(
      `O ficheiro excede ${Math.round(config.uploads.maxBytes / 1024 / 1024)} MB`,
    );
  }
  if (dados.length === 0) throw new ErroValidacao('O ficheiro esta vazio');

  const agora = new Date();
  const dir = join(
    config.uploads.dir,
    tenantId,
    prefixo,
    String(agora.getFullYear()),
    String(agora.getMonth() + 1).padStart(2, '0'),
  );
  await mkdir(dir, { recursive: true });

  const nome = `${randomUUID()}${extensao}`;
  const caminho = join(dir, nome);
  await writeFile(caminho, dados);

  return {
    url: `${config.uploads.baseUrl}/${tenantId}/${prefixo}/${agora.getFullYear()}/${String(
      agora.getMonth() + 1,
    ).padStart(2, '0')}/${nome}`,
    caminho,
    nomeOriginal: nome,
    tamanho: dados.length,
    contentType: contentType.toLowerCase(),
    hash: createHash('sha256').update(dados).digest('hex'),
  };
}