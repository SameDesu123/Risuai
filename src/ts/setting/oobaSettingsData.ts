/**
 * Ooba Settings Data
 *
 * Data-driven definition for the optional parameters in OobaSettings.
 * Unchecked values stay null and are omitted from the request.
 */

import type { SettingContext, SettingItem } from './types';

const isMode = (...modes: string[]) => (ctx: SettingContext) =>
    modes.includes(ctx.db.reverseProxyOobaArgs.mode);

/** Prompt formatting args, shown only outside instruction mode */
export const oobaPromptSettingsItems: SettingItem[] = [
    {
        id: 'ooba.name1_instruct',
        type: 'optional',
        fallbackLabel: 'user prefix',
        bindPath: 'reverseProxyOobaArgs.name1_instruct',
        condition: isMode('instruct'),
    },
    {
        id: 'ooba.name2_instruct',
        type: 'optional',
        fallbackLabel: 'bot prefix',
        bindPath: 'reverseProxyOobaArgs.name2_instruct',
        condition: isMode('instruct'),
    },
    {
        id: 'ooba.context_instruct',
        type: 'optional',
        fallbackLabel: 'system prefix',
        bindPath: 'reverseProxyOobaArgs.context_instruct',
        condition: isMode('instruct'),
    },
    {
        id: 'ooba.system_message',
        type: 'optional',
        fallbackLabel: 'system message',
        bindPath: 'reverseProxyOobaArgs.system_message',
        condition: isMode('instruct'),
    },
    {
        id: 'ooba.name1',
        type: 'optional',
        fallbackLabel: 'user prefix',
        bindPath: 'reverseProxyOobaArgs.name1',
        condition: isMode('chat', 'chat-instruct'),
    },
    {
        id: 'ooba.name2',
        type: 'optional',
        fallbackLabel: 'bot prefix',
        bindPath: 'reverseProxyOobaArgs.name2',
        condition: isMode('chat', 'chat-instruct'),
    },
    {
        id: 'ooba.context',
        type: 'optional',
        fallbackLabel: 'system prefix',
        bindPath: 'reverseProxyOobaArgs.context',
        condition: isMode('chat', 'chat-instruct'),
    },
    {
        id: 'ooba.greeting',
        type: 'optional',
        fallbackLabel: 'start message',
        bindPath: 'reverseProxyOobaArgs.greeting',
        condition: isMode('chat', 'chat-instruct'),
    },
    {
        id: 'ooba.chat_instruct_command',
        type: 'optional',
        fallbackLabel: 'chat_instruct_command',
        bindPath: 'reverseProxyOobaArgs.chat_instruct_command',
        condition: isMode('chat-instruct'),
    },
];

/** Sampling and generation args */
export const oobaParameterSettingsItems: SettingItem[] = [
    {
        id: 'ooba.tokenizer',
        type: 'optional',
        fallbackLabel: 'tokenizer',
        bindPath: 'reverseProxyOobaArgs.tokenizer',
    },
    {
        id: 'ooba.min_p',
        type: 'optional',
        fallbackLabel: 'min_p',
        bindPath: 'reverseProxyOobaArgs.min_p',
        options: { optionalMode: 'number' },
    },
    {
        id: 'ooba.top_k',
        type: 'optional',
        fallbackLabel: 'top_k',
        bindPath: 'reverseProxyOobaArgs.top_k',
        options: { optionalMode: 'number' },
    },
    {
        id: 'ooba.repetition_penalty',
        type: 'optional',
        fallbackLabel: 'repetition_penalty',
        bindPath: 'reverseProxyOobaArgs.repetition_penalty',
        options: { optionalMode: 'number' },
    },
    {
        id: 'ooba.repetition_penalty_range',
        type: 'optional',
        fallbackLabel: 'repetition_penalty_range',
        bindPath: 'reverseProxyOobaArgs.repetition_penalty_range',
        options: { optionalMode: 'number' },
    },
    {
        id: 'ooba.typical_p',
        type: 'optional',
        fallbackLabel: 'typical_p',
        bindPath: 'reverseProxyOobaArgs.typical_p',
        options: { optionalMode: 'number' },
    },
    {
        id: 'ooba.tfs',
        type: 'optional',
        fallbackLabel: 'tfs',
        bindPath: 'reverseProxyOobaArgs.tfs',
        options: { optionalMode: 'number' },
    },
    {
        id: 'ooba.top_a',
        type: 'optional',
        fallbackLabel: 'top_a',
        bindPath: 'reverseProxyOobaArgs.top_a',
        options: { optionalMode: 'number' },
    },
    {
        id: 'ooba.epsilon_cutoff',
        type: 'optional',
        fallbackLabel: 'epsilon_cutoff',
        bindPath: 'reverseProxyOobaArgs.epsilon_cutoff',
        options: { optionalMode: 'number' },
    },
    {
        id: 'ooba.eta_cutoff',
        type: 'optional',
        fallbackLabel: 'eta_cutoff',
        bindPath: 'reverseProxyOobaArgs.eta_cutoff',
        options: { optionalMode: 'number' },
    },
    {
        id: 'ooba.guidance_scale',
        type: 'optional',
        fallbackLabel: 'guidance_scale',
        bindPath: 'reverseProxyOobaArgs.guidance_scale',
        options: { optionalMode: 'number' },
    },
    {
        id: 'ooba.penalty_alpha',
        type: 'optional',
        fallbackLabel: 'penalty_alpha',
        bindPath: 'reverseProxyOobaArgs.penalty_alpha',
        options: { optionalMode: 'number' },
    },
    {
        id: 'ooba.mirostat_mode',
        type: 'optional',
        fallbackLabel: 'mirostat_mode',
        bindPath: 'reverseProxyOobaArgs.mirostat_mode',
        options: { optionalMode: 'number' },
    },
    {
        id: 'ooba.mirostat_tau',
        type: 'optional',
        fallbackLabel: 'mirostat_tau',
        bindPath: 'reverseProxyOobaArgs.mirostat_tau',
        options: { optionalMode: 'number' },
    },
    {
        id: 'ooba.mirostat_eta',
        type: 'optional',
        fallbackLabel: 'mirostat_eta',
        bindPath: 'reverseProxyOobaArgs.mirostat_eta',
        options: { optionalMode: 'number' },
    },
    {
        id: 'ooba.encoder_repetition_penalty',
        type: 'optional',
        fallbackLabel: 'encoder_repetition_penalty',
        bindPath: 'reverseProxyOobaArgs.encoder_repetition_penalty',
        options: { optionalMode: 'number' },
    },
    {
        id: 'ooba.no_repeat_ngram_size',
        type: 'optional',
        fallbackLabel: 'no_repeat_ngram_size',
        bindPath: 'reverseProxyOobaArgs.no_repeat_ngram_size',
        options: { optionalMode: 'number' },
    },
    {
        id: 'ooba.min_length',
        type: 'optional',
        fallbackLabel: 'min_length',
        bindPath: 'reverseProxyOobaArgs.min_length',
        options: { optionalMode: 'number' },
    },
    {
        id: 'ooba.num_beams',
        type: 'optional',
        fallbackLabel: 'num_beams',
        bindPath: 'reverseProxyOobaArgs.num_beams',
        options: { optionalMode: 'number' },
    },
    {
        id: 'ooba.length_penalty',
        type: 'optional',
        fallbackLabel: 'length_penalty',
        bindPath: 'reverseProxyOobaArgs.length_penalty',
        options: { optionalMode: 'number' },
    },
    {
        id: 'ooba.truncation_length',
        type: 'optional',
        fallbackLabel: 'truncation_length',
        bindPath: 'reverseProxyOobaArgs.truncation_length',
        options: { optionalMode: 'number' },
    },
    {
        id: 'ooba.max_tokens_second',
        type: 'optional',
        fallbackLabel: 'max_tokens_second',
        bindPath: 'reverseProxyOobaArgs.max_tokens_second',
        options: { optionalMode: 'number' },
    },
    {
        id: 'ooba.negative_prompt',
        type: 'optional',
        fallbackLabel: 'negative_prompt',
        bindPath: 'reverseProxyOobaArgs.negative_prompt',
    },
    {
        id: 'ooba.custom_token_bans',
        type: 'optional',
        fallbackLabel: 'custom_token_bans',
        bindPath: 'reverseProxyOobaArgs.custom_token_bans',
    },
    {
        id: 'ooba.grammar_string',
        type: 'optional',
        fallbackLabel: 'grammar_string',
        bindPath: 'reverseProxyOobaArgs.grammar_string',
    },
    {
        id: 'ooba.temperature_last',
        type: 'optional',
        fallbackLabel: 'temperature_last',
        bindPath: 'reverseProxyOobaArgs.temperature_last',
        options: { optionalMode: 'bool' },
    },
    {
        id: 'ooba.do_sample',
        type: 'optional',
        fallbackLabel: 'do_sample',
        bindPath: 'reverseProxyOobaArgs.do_sample',
        options: { optionalMode: 'bool' },
    },
    {
        id: 'ooba.early_stopping',
        type: 'optional',
        fallbackLabel: 'early_stopping',
        bindPath: 'reverseProxyOobaArgs.early_stopping',
        options: { optionalMode: 'bool' },
    },
    {
        id: 'ooba.auto_max_new_tokens',
        type: 'optional',
        fallbackLabel: 'auto_max_new_tokens',
        bindPath: 'reverseProxyOobaArgs.auto_max_new_tokens',
        options: { optionalMode: 'bool' },
    },
    {
        id: 'ooba.ban_eos_token',
        type: 'optional',
        fallbackLabel: 'ban_eos_token',
        bindPath: 'reverseProxyOobaArgs.ban_eos_token',
        options: { optionalMode: 'bool' },
    },
    {
        id: 'ooba.add_bos_token',
        type: 'optional',
        fallbackLabel: 'add_bos_token',
        bindPath: 'reverseProxyOobaArgs.add_bos_token',
        options: { optionalMode: 'bool' },
    },
    {
        id: 'ooba.skip_special_tokens',
        type: 'optional',
        fallbackLabel: 'skip_special_tokens',
        bindPath: 'reverseProxyOobaArgs.skip_special_tokens',
        options: { optionalMode: 'bool' },
    },
];
