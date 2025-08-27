import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const openAIApiKey = Deno.env.get('OPENAI_API_KEY');
const supabaseUrl = Deno.env.get('SUPABASE_URL');
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

const supabase = createClient(supabaseUrl!, supabaseServiceKey!);

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Helpers de normalização e tokenização
const STOPWORDS = new Set(['que','como','para','por','com','sem','sob','sobre','qual','onde','quando','fale','me','do','da','de','em','no','na','os','as','uma','um','quais','você','voce','sua','seu','minha','meu','tem','há','ha']);
const normalize = (s: string) => (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const tokenize = (s: string) => normalize(s).split(/[^a-z0-9]+/).filter(w => w.length > 2 && !STOPWORDS.has(w));

// Helper para extrair emojis de um texto (evita repetição)
function extractEmojis(text: string): string[] {
  if (!text) return [];
  try {
    const regex = /\p{Extended_Pictographic}/gu;
    const matches = text.match(regex) || [];
    return Array.from(new Set(matches)).slice(0, 20);
  } catch {
    const fallbackRegex = /[\u231A-\uD83E\uDDFF]/g;
    const matches = text.match(fallbackRegex) || [];
    return Array.from(new Set(matches)).slice(0, 20);
  }
}

// Função para buscar documentos relevantes baseado na consulta do usuário
async function searchRelevantDocuments(userQuery: string) {
  try {
    console.log('Iniciando busca por documentos relevantes para:', userQuery);
    
    // Buscar todos os documentos
    const { data: allDocs, error } = await supabase
      .from('company_documents')
      .select('id, filename, content')
      .limit(100);

    if (error) {
      console.error('Erro ao buscar documentos:', error);
      return 'Nenhum documento encontrado.';
    }

    if (!allDocs || allDocs.length === 0) {
      console.log('Nenhum documento no banco de dados');
      return 'Nenhum documento da empresa foi carregado. Por favor, peça ao administrador para carregar os documentos oficiais.';
    }

    console.log(`Encontrados ${allDocs.length} documentos para análise`);

    // Tokens da consulta do usuário (normalizados)
    const queryTokens = tokenize(userQuery);
    console.log('Tokens extraídos da consulta:', queryTokens);

    // Calcular relevância de cada documento (com boost para o nome do arquivo)
    const docsWithScore = allDocs.map(doc => {
      const filenameNorm = normalize(doc.filename || '');
      const contentNorm = normalize(doc.content || '');
      let score = 0;

      queryTokens.forEach(tok => {
        // Correspondências exatas por palavra (conteúdo)
        const wordRegex = new RegExp(`\\b${tok}\\b`, 'g');
        const matchesContent = contentNorm.match(wordRegex) || [];
        score += matchesContent.length * 10; // peso para conteúdo

        // Correspondência parcial no conteúdo
        if (contentNorm.includes(tok)) score += 5;

        // Boost forte se aparecer no nome do arquivo
        const matchesFile = filenameNorm.match(wordRegex) || [];
        score += matchesFile.length * 30; // título pesa mais
        if (filenameNorm.includes(tok)) score += 10;
      });

      return { ...doc, score };
    });

    // Ordenar por relevância e pegar os mais relevantes
    const relevantDocs = docsWithScore
      .filter(doc => doc.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5); // até 5 documentos

    console.log('Documentos relevantes encontrados:', relevantDocs.map(d => ({ filename: d.filename, score: d.score })));

    if (relevantDocs.length === 0) {
      return `Não encontrei informações específicas sobre "${userQuery}" nos documentos carregados. Os documentos disponíveis são: ${allDocs.map(d => d.filename).join(', ')}. Tente reformular sua pergunta ou seja mais específico.`;
    }

    // Formatar contexto dos documentos mais relevantes (com limite de caracteres)
    const contextDocs = relevantDocs.map(doc => {
      // Limitar cada documento a 3000 caracteres para acelerar o processamento
      const truncatedContent = doc.content.length > 3000 
        ? doc.content.substring(0, 3000) + '\n[... documento truncado para otimizar resposta ...]'
        : doc.content;
      
      return `=== DOCUMENTO: ${doc.filename} (Relevância: ${doc.score}) ===\n${truncatedContent}\n=== FIM DO DOCUMENTO ===\n`;
    }).join('\n');

    console.log(`Contexto preparado com ${contextDocs.length} caracteres de ${relevantDocs.length} documentos`);
    
    return contextDocs;
  } catch (error) {
    console.error('Erro na busca de documentos:', error);
    return 'Erro ao processar documentos da empresa.';
  }
}

serve(async (req) => {
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    if (!openAIApiKey) {
      console.error('OPENAI_API_KEY não configurada');
      throw new Error('OpenAI API key não configurada');
    }

    const requestBody = await req.json();
    const { message, conversationHistory = [] } = requestBody;

    if (!message) {
      throw new Error('Mensagem é obrigatória');
    }

    console.log('=== NOVA CONSULTA ===');
    console.log('Mensagem recebida:', message);
    console.log('Histórico de conversação:', conversationHistory.length, 'mensagens');

    // Intenção: listar documentos disponíveis (responde sem chamar OpenAI)
    const msgNorm = normalize(message);
    const listIntent = /(quais|listar|liste|que).*documentos/.test(msgNorm) || /(base|banco).*documento/.test(msgNorm);
    if (listIntent) {
      console.log('Intenção detectada: listar documentos');
      const { data: docs, error: docsError } = await supabase
        .from('company_documents')
        .select('filename, created_at')
        .order('created_at', { ascending: false })
        .limit(50);
      if (docsError) {
        console.error('Erro ao listar documentos:', docsError);
        return new Response(JSON.stringify({ response: 'Não consegui listar os documentos agora. Tente novamente em instantes.' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      const list = (docs || []).map((d: any, i: number) => `${i + 1}. ${d.filename}`).join('\n') || 'Nenhum documento encontrado.';
      const text = `Atualmente, tenho acesso aos seguintes documentos na base:\n\n${list}\n\nSe quiser, posso buscar informações específicas em algum deles.`;
      return new Response(JSON.stringify({ response: text, tokens: 0 }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Buscar documentos relevantes usando RAG
    const relevantContext = await searchRelevantDocuments(message);
    console.log('Contexto encontrado, enviando para OpenAI...');

    // Preparar mensagens com histórico e contexto
    const systemPrompt = `Você é o MAX, assistente virtual da Fiscaltech.

OBJETIVO:
Oferecer suporte confiável, rápido e direto sobre processos, condutas, políticas e normas INTERNAS da empresa, com linguagem acolhedora e humanizada.

SAUDAÇÃO PADRÃO:
- Para usuários em geral: "Olá! Eu sou o Max, seu assistente virtual na Fiscaltech. Como posso te ajudar?"
- Para usuários novos: "Você é novo na empresa ou está começando em alguma área específica? Assim eu consigo te orientar melhor" (use no máximo 1 emoji variando entre 🙂, 👋, 😊)

REGRAS OBRIGATÓRIAS E IRREVOGÁVEIS:
1. Use EXCLUSIVAMENTE os documentos internos fornecidos abaixo - JAMAIS invente informações ou processos
2. NUNCA forneça links para download de arquivos, mesmo que sejam documentos internos da empresa
3. NÃO invente equipamentos, processos, normas ou exemplos que não estejam explicitamente descritos nos documentos
4. PROIBIDO buscar ou usar referências externas/internet - responda APENAS com base no material oficial da empresa
5. Se não souber algo baseado nos documentos, diga claramente "Não encontrei essa informação nos documentos disponíveis"

LIMITAÇÕES DE RESPOSTA - NÃO RESPONDA SOBRE:
- Salários, bonificações, remuneração
- Decisões de gestão
- Dados externos ou não documentados
- Normas ou regulamentações que não sejam INTERNAS da Fiscaltech

OBRIGATÓRIO EM TODA RESPOSTA:
- Indique SEMPRE o nome do documento de origem quando usar informação específica
- Use linguagem simples, cordial e acessível
- Estimule que o usuário continue a conversa com sugestões úteis baseadas nos documentos

CONTEXTO DOS DOCUMENTOS INTERNOS DA FISCALTECH:
${relevantContext}

INSTRUÇÕES TÉCNICAS:
- Responda sempre em português brasileiro
- Substitua $ por S em suas respostas
- Use emojis com moderação (máx. 2) e de forma contextual
- Varie os emojis e evite repetir o mesmo emoji em respostas consecutivas
- Prefira 🙂, 👋, 😊, 👍, ✅, 📝, 📄, ℹ️, 🛠️ quando fizer sentido
- Seja conciso mas completo (3-6 frases quando possível)
- Se documento tiver problemas técnicos, informe que precisa ser recarregado`;


    // Construir array de mensagens com histórico
    const messages = [
      { role: 'system', content: systemPrompt }
    ];

    // Adicionar histórico de conversação (limitado às últimas 10 mensagens)
    const recentHistory = conversationHistory.slice(-10);
    messages.push(...recentHistory);

    // Evitar repetição de emojis usados na última resposta do assistente
    const lastAssistant: any = [...recentHistory].reverse().find((m: any) => m.role === 'assistant');
    const lastEmojis = lastAssistant ? extractEmojis(lastAssistant.content || '') : [];
    if (lastEmojis.length > 0) {
      const avoidList = lastEmojis.join(' ');
      messages.push({
        role: 'system',
        content: `Não use estes emojis nesta resposta: ${avoidList}. Varie, e se for usar emojis, escolha outros que façam sentido (máx. 2).`
      });
      console.log('Evitando emojis desta resposta:', avoidList);
    }
    
    // Adicionar mensagem atual
    messages.push({ role: 'user', content: message });

    console.log('Enviando', messages.length, 'mensagens para OpenAI (incluindo system + histórico + atual)');

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${openAIApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages,
        max_tokens: 500,
        temperature: 0.65,
      }),
    });

    if (!response.ok) {
      const errorData = await response.text();
      console.error('Erro na API OpenAI:', response.status, errorData);
      throw new Error(`Erro na API OpenAI: ${response.status} - ${errorData}`);
    }

    const data = await response.json();
    console.log('Resposta da OpenAI recebida com sucesso');

    // Extrair texto de forma resiliente (modelos novos podem variar o formato)
    const choice = data?.choices?.[0] ?? {};
    const messageContent = choice?.message ?? {};

    function coerceToText(content: any): string {
      if (!content) return '';
      if (typeof content === 'string') return content;
      if (Array.isArray(content)) {
        try {
          return content
            .map((part: any) =>
              typeof part === 'string'
                ? part
                : (part?.text ?? part?.content ?? '')
            )
            .join('')
            .trim();
        } catch (_) {
          return '';
        }
      }
      // Último recurso: stringify seguro
      try {
        return JSON.stringify(content);
      } catch (_) {
        return '';
      }
    }

    let aiResponseText = coerceToText(messageContent.content).trim();

    if (!aiResponseText) {
      console.warn('OpenAI retornou conteúdo vazio. Dump parcial da escolha:',
        JSON.stringify({ finish_reason: choice.finish_reason, messageKeys: Object.keys(messageContent || {}) }).slice(0, 500)
      );
      aiResponseText = 'Não encontrei informações suficientes para responder com precisão agora. Tente reformular a pergunta ou ser mais específico.';
    }

    const tokensUsed = data?.usage?.total_tokens || 0;

    console.log(`Tokens utilizados: ${tokensUsed}`);
    console.log('=== FIM DA CONSULTA ===');

    return new Response(JSON.stringify({
      response: aiResponseText,
      tokens: tokensUsed
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error('Erro na função chat-ai:', error);
    return new Response(JSON.stringify({ 
      error: error.message || 'Erro interno do servidor' 
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});