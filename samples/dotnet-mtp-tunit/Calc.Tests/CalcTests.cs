namespace Calc.Tests;

public class CalcTests
{
    [Test]
    public async Task AddsTwoNumbers()
    {
        await Assert.That(Calculator.Add(2, 3)).IsEqualTo(5);
    }
}
