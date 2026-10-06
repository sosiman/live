/**
 * Herramientas que el modelo puede llamar mientras habla.
 * Declaraciones en setup.tools; el modelo responde toolCall y se contesta con
 * toolResponse usando el mismo id. Después retoma la voz por su cuenta.
 */
const TZ_DEFAULT = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

export function buildToolDeclarations(settings = {}) {
  const declarations = [];
  if (settings.toolSearch !== false) {
    declarations.push({
      name: 'buscar_en_web',
      description: 'Busca en internet informacion ACTUAL y devuelve un resumen con las fuentes. ' +
        'Usala SIEMPRE antes de responder sobre loot, porcentajes de drop, vendedores, precios, ' +
        'estadisticas, BiS, builds, talentos, sims, notas de parche, fechas de temporada o cualquier ' +
        'dato que pueda haber cambiado. Nunca contestes eso de memoria ni digas que no puedes buscar.',
      parameters: {
        type: 'OBJECT',
        properties: {
          consulta: { type: 'STRING', description: 'Que buscar, en el idioma que sea mas util.' },
          fuente: {
            type: 'STRING',
            description: 'Web donde buscar (opcional, recomendado). Valores: ' +
              'wowhead (objetos, misiones, NPCs, mapas, coordenadas, drop), ' +
              'wowhead-es (lo mismo en espanol), icy-veins (guias de clase, raids, dungeons), ' +
              'murlok (builds y stats reales de M+ y PvP), raiderio (puntuacion M+), ' +
              'warcraftlogs (logs y parses), wago (WeakAuras), curseforge (addons), ' +
              'wowprogress (progresion de guilds), method (guias), simc (simulaciones), ' +
              'general (cuando no sepas cual).',
          },
        },
        required: ['consulta'],
      },
    });
  }
  if (settings.toolTime !== false) {
    declarations.push({
      name: 'hora_actual',
      description: 'Devuelve la fecha y la hora actuales.',
      parameters: { type: 'OBJECT', properties: { zona_horaria: { type: 'STRING', description: 'Zona IANA, por ejemplo Europe/Madrid.' } } },
    });
  }
  if (settings.toolTranslate !== false) {
    declarations.push({
      name: 'traducir_texto',
      description: 'Traduce un texto a otro idioma. Úsala para traducir algo concreto en vez de conversar.',
      parameters: {
        type: 'OBJECT',
        properties: { texto: { type: 'STRING' }, idioma_destino: { type: 'STRING', description: 'Código BCP-47: es, en, uk…' } },
        required: ['texto'],
      },
    });
  }
  if (settings.toolVolume !== false) {
    declarations.push({
      name: 'ajustar_volumen',
      description: 'Ajusta el volumen con el que suena tu voz (0 a 100).',
      parameters: { type: 'OBJECT', properties: { nivel: { type: 'INTEGER' } }, required: ['nivel'] },
    });
  }
  if (settings.toolStatus !== false) {
    declarations.push({ name: 'estado_sesion', description: 'Informa del estado: modelo, idioma y duración.', parameters: { type: 'OBJECT', properties: {} } });
  }
  // NO se declara el googleSearch del servidor: medido que el Live API lo acepta
  // pero no busca. La busqueda real la hace buscar_en_web por REST.
  return declarations.length ? [{ functionDeclarations: declarations }] : [];
}

export async function executeToolCall(name, args = {}, ctx = {}) {
  switch (name) {
    case 'hora_actual': {
      const timeZone = args.zona_horaria || TZ_DEFAULT();
      let hora;
      try { hora = new Intl.DateTimeFormat('es-ES', { dateStyle: 'full', timeStyle: 'short', timeZone }).format(new Date()); }
      catch { hora = new Date().toISOString(); }
      return { ok: true, hora, zona_horaria: timeZone };
    }
    case 'traducir_texto': {
      const texto = String(args.texto || '').trim();
      const destino = String(args.idioma_destino || ctx.defaultTarget || 'es').trim();
      if (!texto) return { ok: false, error: 'No hay texto que traducir.' };
      try { return { ok: true, traduccion: await ctx.translate(texto, destino), idioma_destino: destino }; }
      catch (err) { return { ok: false, error: String(err.message || err) }; }
    }
    case 'ajustar_volumen': {
      const nivel = Math.max(0, Math.min(100, Number(args.nivel ?? 50)));
      ctx.setVolume?.(nivel);
      return { ok: true, nivel };
    }
    case 'buscar_en_web': {
      const consulta = String(args.consulta || '').trim();
      if (!consulta) return { ok: false, error: 'Falta la consulta.' };
      if (!ctx.search) return { ok: false, error: 'La busqueda no esta disponible.' };
      try {
        const r = await ctx.search(consulta, String(args.fuente || '').trim());
        return { ok: true, resumen: r.resumen, fuentes: r.fuentes, consultas: r.consultas, fecha_consulta: r.fecha };
      } catch (err) {
        return { ok: false, error: String(err.message || err) };
      }
    }
    case 'estado_sesion':
      return { ok: true, ...(ctx.getState?.() || {}) };
    default:
      return { ok: false, error: 'Herramienta desconocida: ' + name };
  }
}
