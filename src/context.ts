/**
 * This is the default context of values not explicitly mentioned in the run options.
 * To override any of these values simply provide them during runtime.
 *
 * @field langDir the directory holding all json language files
 * @field model the OpenAI model to use, tested with "gpt-4o"
 * @field baseLanguage the ISO639-1 two-letter base language code name (i.e., "en") of the company to use as reference in key-value translation pairs
 * @field validatedLanguages a list of ISO639-1 two-letter code names of all human validated languages
 * @field companyName the name of the company, used to create more tailored system messages
 * @field companyDescription the name of the company, used to create more tailored system messages with the form: "...working for a company called [companyName]. [companyDescription]"
 * @field fillerWord true if terms in the language files contain the placeholder '%s' for dynamic strings
 */
export const DEFAULT_CONTEXT = {
    langDir: "./src/langs/",
    model: "gpt-4o",
    baseLanguage: "en",
    validatedLanguages: [],
    companyName: "",
    companyDescription: "",
    fillerWord: true,
}
