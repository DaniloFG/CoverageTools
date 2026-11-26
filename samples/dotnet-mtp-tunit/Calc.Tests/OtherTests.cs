namespace Calc.Tests;

public class OtherTests
{
    [Test]
    public async Task DividesTwoNumbers()
    {
        await Assert.That(Calculator.Divide(6, 3)).IsEqualTo(2);
    }
}
