// @ts-check



export function looksReDosProne(pattern) {
  return /\([^)]*[+*][^)]*\)[+*{]/.test(pattern) || /(\.\*){3,}/.test(pattern) || /\[[^\]]+\][+*]\s*[+*{]/.test(pattern);
}
