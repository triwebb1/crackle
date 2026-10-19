type Operator = '+' | '-' | '*' | '/'

const precedence: Record<Operator, number> = {
  '+': 1,
  '-': 1,
  '*': 2,
  '/': 2,
}

const applyOperator = (values: number[], operator: Operator) => {
  const right = values.pop()
  const left = values.pop()
  if (left === undefined || right === undefined) return false

  const result =
    operator === '+' ? left + right : operator === '-' ? left - right : operator === '*' ? left * right : left / right

  if (!Number.isFinite(result)) return false
  values.push(result)
  return true
}

export const evaluateNumericExpression = (expression: string): number | undefined => {
  const compact = expression.replace(/\s+/g, '')
  if (!compact || !/^[\d.+\-*/()]+$/.test(compact)) return undefined

  const values: number[] = []
  const operators: Array<Operator | '('> = []
  let index = 0
  let expectsValue = true

  const reduce = (minimumPrecedence = 0) => {
    while (operators.length) {
      const operator = operators.at(-1)
      if (operator === undefined) return false
      if (operator === '(' || precedence[operator] < minimumPrecedence) break
      operators.pop()
      if (!applyOperator(values, operator)) return false
    }
    return true
  }

  while (index < compact.length) {
    const character = compact[index]

    if (character === '(') {
      if (!expectsValue) return undefined
      operators.push(character)
      index += 1
      continue
    }

    if (character === ')') {
      if (expectsValue || !reduce()) return undefined
      if (operators.pop() !== '(') return undefined
      expectsValue = false
      index += 1
      continue
    }

    if ('+-*/'.includes(character)) {
      if (expectsValue) {
        if (character !== '+' && character !== '-') return undefined
        const match = compact.slice(index).match(/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)/)
        if (!match) return undefined
        values.push(Number(match[0]))
        index += match[0].length
        expectsValue = false
        continue
      }

      const operator = character as Operator
      if (!reduce(precedence[operator])) return undefined
      operators.push(operator)
      expectsValue = true
      index += 1
      continue
    }

    if (!expectsValue) return undefined
    const match = compact.slice(index).match(/^(?:\d+(?:\.\d*)?|\.\d+)/)
    if (!match) return undefined
    values.push(Number(match[0]))
    index += match[0].length
    expectsValue = false
  }

  if (expectsValue || !reduce() || operators.length || values.length !== 1) return undefined
  return values[0]
}

export const formatCalculatedNumber = (value: number, decimalPlaces = 6) =>
  Number(value.toFixed(decimalPlaces)).toString()
